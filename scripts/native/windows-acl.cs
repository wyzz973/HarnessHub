using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

// A narrow local filesystem helper. Input is data on stdin; it never runs a
// command or returns directory names, account names, descriptors or file bytes.
internal static class WindowsAcl
{
    public sealed class Request
    {
        public string[] paths { get; set; }
        public string kind { get; set; }
        public bool protect { get; set; }
    }

    private static bool Allowed(SecurityIdentifier sid, SecurityIdentifier user)
    {
        return sid.Equals(user) || sid.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
            sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
    }

    private static bool Desired(FileSystemSecurity security, SecurityIdentifier user)
    {
        if (!security.AreAccessRulesProtected || !security.GetOwner(typeof(SecurityIdentifier)).Equals(user)) return false;
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        int required = user.IsWellKnown(WellKnownSidType.LocalSystemSid) || user.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) ? 2 : 3;
        if (rules.Count != required) return false;
        foreach (FileSystemAccessRule rule in rules)
            if (!Allowed((SecurityIdentifier)rule.IdentityReference, user) || rule.IsInherited ||
                rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl ||
                rule.InheritanceFlags != (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) ||
                rule.PropagationFlags != PropagationFlags.None) return false;
        return true;
    }

    private static void Protect(string location, SecurityIdentifier user)
    {
        var existing = Directory.GetAccessControl(location);
        // Do not rewrite an already correct DACL: propagation could otherwise
        // change metadata while another published artifact is being read.
        if (Desired(existing, user)) return;
        var security = new DirectorySecurity();
        security.SetOwner(user);
        security.SetAccessRuleProtection(true, false);
        var principals = new[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) };
        foreach (var sid in principals)
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(location, security);
    }

    private static void Verify(string location, bool directory, SecurityIdentifier user)
    {
        FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(location) : File.GetAccessControl(location);
        if (!Allowed((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier)), user)) throw new UnauthorizedAccessException();
        bool ownerAllowed = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (!Allowed(sid, user)) throw new UnauthorizedAccessException();
            if (sid.Equals(user) && (rule.PropagationFlags & PropagationFlags.InheritOnly) == 0 &&
                (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl) ownerAllowed = true;
        }
        if (!ownerAllowed) throw new UnauthorizedAccessException();
    }

    private static string NativePath(string location)
    {
        if (String.IsNullOrEmpty(location) || !Path.IsPathRooted(location)) throw new ArgumentException();
        location = location.Replace('/', '\\');
        if (!location.StartsWith(@"\\") && (location.Length < 3 || location[1] != ':' || location[2] != '\\')) throw new ArgumentException();
        if (location.StartsWith(@"\\?\")) return location;
        if (location.StartsWith(@"\\")) return @"\\?\UNC\" + location.Substring(2);
        return @"\\?\" + location;
    }

    private static Request ReadRequest()
    {
        var input = new StringBuilder();
        for (int next; (next = Console.In.Read()) != -1 && next != '\n'; )
        {
            if (input.Length >= 65536) throw new ArgumentException();
            input.Append((char)next);
        }
        if (input.Length == 0) return null;
        return new JavaScriptSerializer { MaxJsonLength = 65536 }.Deserialize<Request>(input.ToString());
    }

    private static void Check(Request request, SecurityIdentifier user)
    {
        if (request == null || request.paths == null || request.paths.Length == 0 || request.paths.Length > 64 ||
            (request.kind != "directory" && request.kind != "file" && request.kind != "any") || (request.protect && request.kind != "directory")) throw new ArgumentException();
        foreach (string original in request.paths)
        {
            string location = NativePath(original);
            var attributes = File.GetAttributes(location);
            bool directory = (attributes & FileAttributes.Directory) != 0;
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (request.kind != "any" && directory != (request.kind == "directory"))) throw new IOException();
            if (request.protect) Protect(location, user);
            Verify(location, directory, user);
        }
    }

    private static int Main(string[] arguments)
    {
        FileStream lease = null;
        try
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            Console.InputEncoding = new UTF8Encoding(false, true);
            bool session = arguments.Length == 1 && arguments[0] == "--session";
            var user = WindowsIdentity.GetCurrent().User;
            if (!session)
            {
                Check(ReadRequest(), user);
                Console.Out.Write("private");
                return 0;
            }
            Console.Out.WriteLine("ready");
            Console.Out.Flush();
            for (Request request; (request = ReadRequest()) != null; )
            {
                if (request.kind == "read-lock")
                {
                    if (lease != null || request.paths == null || request.paths.Length != 1 || request.protect) throw new ArgumentException();
                    string location = NativePath(request.paths[0]);
                    var attributes = File.GetAttributes(location);
                    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new IOException();
                    // Deny writing/deletion, including pre-existing writer handles.
                    lease = new FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read);
                    Console.Out.WriteLine("locked");
                }
                else if (request.kind == "release")
                {
                    if (lease == null) throw new ArgumentException();
                    lease.Dispose();
                    lease = null;
                    Console.Out.WriteLine("released");
                }
                else
                {
                    Check(request, user);
                    Console.Out.WriteLine("private");
                }
                Console.Out.Flush();
            }
            return 0;
        }
        catch
        {
            Console.Error.Write("Windows private filesystem verification failed");
            return 1;
        }
        finally
        {
            if (lease != null) lease.Dispose();
        }
    }
}
