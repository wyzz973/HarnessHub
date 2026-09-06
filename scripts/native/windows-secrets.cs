using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// One JSON request over stdin. No credential or decryption material enters argv.
// Existing public keychain references resolve within this application's namespace.
internal static class WindowsSecrets {
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
  private static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
  private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("HarnessHub/engine-credentials/v1");
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder directory, ref uint size);

  private static void CheckPath(string location) {
    for (string current = Path.GetFullPath(location); current != null; current = Path.GetDirectoryName(current)) {
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException();
    }
  }

  private static void CheckAcl(string location, bool directory) {
    FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(location) : File.GetAccessControl(location);
    CheckSecurity(acl);
  }

  private static void CheckSecurity(FileSystemSecurity acl) {
    var owner = (SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
    if (!owner.Equals(User)) throw new UnauthorizedAccessException();
    var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      var sid = (SecurityIdentifier)rule.IdentityReference;
      if (rule.AccessControlType == AccessControlType.Allow && !sid.Equals(User) && !sid.Equals(system) && !sid.Equals(admins))
        throw new UnauthorizedAccessException();
    }
  }

  private static string CanonicalPath(SafeFileHandle handle) {
    var canonical = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(handle, canonical, (uint)canonical.Capacity, 0);
    if (length == 0 || length >= canonical.Capacity) throw new IOException();
    string actual = canonical.ToString();
    if (actual.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + actual.Substring(8);
    if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) return actual.Substring(4);
    return actual;
  }

  private static byte[] ReadPrivateFile(string file, int limit) {
    string full = Path.GetFullPath(file);
    if (!Path.IsPathRooted(file)) throw new IOException();
    CheckPath(full);
    using (SafeFileHandle handle = CreateFile(full, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new IOException();
      string actual = CanonicalPath(handle);
      if (!String.Equals(full, actual, StringComparison.OrdinalIgnoreCase)) throw new IOException();
      using (var stream = new FileStream(handle, FileAccess.Read)) {
        CheckSecurity(stream.GetAccessControl());
        if (stream.Length > limit) throw new IOException();
        using (var output = new MemoryStream()) { stream.CopyTo(output); return output.ToArray(); }
      }
    }
  }

  private static string Root() {
    // Worker HOME/USERPROFILE/LOCALAPPDATA belong to the isolated engine, not
    // to the credential owner. Ask Windows for the token's profile so create,
    // read and delete retain one identity across these process environments.
    string parent;
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      var profile = new StringBuilder(32768);
      uint length = (uint)profile.Capacity;
      if (!GetUserProfileDirectory(identity.Token, profile, ref length) || profile.Length == 0) throw new IOException();
      parent = Path.Combine(profile.ToString(), "AppData", "Local");
    }
    CheckPath(parent);
    string root = Path.Combine(parent, "HarnessHub", "secrets-v1");
    string app = Path.GetDirectoryName(root);
    if (!Directory.Exists(app)) Directory.CreateDirectory(app);
    CheckPath(app);
    if (!Directory.Exists(root)) {
      var acl = new DirectorySecurity();
      acl.SetOwner(User);
      acl.SetAccessRuleProtection(true, false);
      acl.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.CreateDirectory(root, acl);
    }
    CheckPath(root);
    CheckAcl(root, true);
    // Packaged Windows hosts can transparently virtualize LocalApplicationData.
    // Resolve our verified directory once so later file-handle comparisons use
    // its physical path, while still rejecting reparse points and foreign ACLs.
    using (SafeFileHandle handle = CreateFile(root, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new IOException();
      root = CanonicalPath(handle);
    }
    CheckPath(root);
    CheckAcl(root, true);
    return root;
  }

  private static string Get(Dictionary<string, object> request, string name) {
    object value;
    if (!request.TryGetValue(name, out value) || !(value is string)) throw new ArgumentException();
    return (string)value;
  }

  public static int Main() {
    try {
      Console.InputEncoding = new UTF8Encoding(false, true);
      Console.OutputEncoding = new UTF8Encoding(false);
      var input = new StringBuilder();
      int c;
      while ((c = Console.Read()) != -1) { if (input.Length >= 65536) throw new ArgumentException(); input.Append((char)c); }
      var request = Json.Deserialize<Dictionary<string, object>>(input.ToString());
      string operation = Get(request, "operation");
      if (operation == "read-file") {
        string source = Get(request, "id");
        Console.Write(Json.Serialize(new { value = new UTF8Encoding(false, true).GetString(ReadPrivateFile(source, 8192)) }));
        return 0;
      }
      Guid id;
      if (!Guid.TryParseExact(Get(request, "id"), "D", out id)) throw new ArgumentException();
      string file = Path.Combine(Root(), id.ToString("D") + ".dpapi");
      if (operation == "create") {
        string value = Get(request, "value");
        byte[] plain = Encoding.UTF8.GetBytes(value);
        if (String.IsNullOrWhiteSpace(value) || plain.Length > 8192 || value.IndexOfAny(new[] {'\r', '\n', '\0'}) >= 0) throw new ArgumentException();
        byte[] encrypted;
        try { encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser); }
        finally { Array.Clear(plain, 0, plain.Length); }
        using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          stream.Write(encrypted, 0, encrypted.Length);
          stream.Flush(true);
        }
      } else {
        CheckPath(file);
        CheckAcl(file, false);
        if (operation == "read") {
          byte[] encrypted = ReadPrivateFile(file, 16384);
          byte[] plain = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
          try { Console.Write(Json.Serialize(new { value = new UTF8Encoding(false, true).GetString(plain) })); }
          finally { Array.Clear(plain, 0, plain.Length); }
          return 0;
        }
        if (operation != "delete") throw new ArgumentException();
        File.Delete(file);
      }
      Console.Write("{\"ok\":true}");
      return 0;
    } catch { Console.Write("{\"error\":\"secret unavailable\"}"); return 1; }
  }
}
