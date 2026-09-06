using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Reads MSI tables and embedded cabinets. Never invokes MsiInstallProduct,
// MsiConfigureProduct, custom actions, msiexec, or product registration.
public static class HarnessHubMsiArchive
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
    [DllImport("msi.dll")]
    private static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")]
    private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder buffer, ref uint size);
    [DllImport("msi.dll")]
    private static extern uint MsiRecordReadStream(uint record, uint field, [Out] byte[] buffer, ref uint size);
    [DllImport("msi.dll")]
    private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern int MsiQueryProductStateW(string productCode);

    public static int ProductState(string archive)
    {
        uint database;
        Check(MsiOpenDatabaseW(Path.GetFullPath(archive), IntPtr.Zero, out database), "Open MSI read-only");
        try
        {
            var rows = Rows(database, "SELECT `Value` FROM `Property` WHERE `Property` = 'ProductCode'", 1);
            if (rows.Count != 1) throw new InvalidDataException("MSI ProductCode missing");
            return MsiQueryProductStateW(rows[0][0]);
        }
        finally { MsiCloseHandle(database); }
    }

    private static void Check(uint code, string operation)
    {
        if (code != 0) throw new Win32Exception((int)code, operation);
    }

    private static string Field(uint record, uint field)
    {
        uint size = 1024;
        var buffer = new StringBuilder((int)size);
        uint result = MsiRecordGetStringW(record, field, buffer, ref size);
        if (result == 234)
        {
            size++;
            buffer = new StringBuilder((int)size);
            result = MsiRecordGetStringW(record, field, buffer, ref size);
        }
        Check(result, "Read MSI field");
        return buffer.ToString();
    }

    private static List<string[]> Rows(uint database, string query, uint fields)
    {
        uint view;
        Check(MsiDatabaseOpenViewW(database, query, out view), "Open read-only MSI view");
        try
        {
            Check(MsiViewExecute(view, 0), "Execute read-only MSI query");
            var rows = new List<string[]>();
            uint record;
            uint result;
            while ((result = MsiViewFetch(view, out record)) == 0)
            {
                try
                {
                    var row = new string[fields];
                    for (uint field = 1; field <= fields; field++) row[field - 1] = Field(record, field);
                    rows.Add(row);
                }
                finally { MsiCloseHandle(record); }
            }
            if (result != 259) Check(result, "Fetch MSI row");
            return rows;
        }
        finally { MsiCloseHandle(view); }
    }

    private static string Contained(string root, string child)
    {
        var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(Path.Combine(root, child));
        if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("MSI path escapes extraction directory");
        return target;
    }

    private static string LongName(string value)
    {
        var target = value.Split(':')[0];
        var pair = target.Split('|');
        return pair[pair.Length - 1];
    }

    private static string DirectoryPath(string id, Dictionary<string, string[]> directories, HashSet<string> seen)
    {
        if (!seen.Add(id)) throw new InvalidDataException("MSI directory cycle");
        string[] row;
        if (!directories.TryGetValue(id, out row)) throw new InvalidDataException("Unknown MSI directory");
        var parent = row[1];
        if (parent.Length == 0) return "";
        var prefix = DirectoryPath(parent, directories, seen);
        var name = LongName(row[2]);
        if (name == "." || name == "SourceDir") return prefix;
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name == "..")
            throw new InvalidDataException("Invalid MSI directory name");
        return Path.Combine(prefix, name);
    }

    public static string[] Extract(string archive, string destination)
    {
        destination = Path.GetFullPath(destination);
        if (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length != 0)
            throw new IOException("MSI extraction target must be empty");
        Directory.CreateDirectory(destination);
        var cabinetRoot = Contained(destination, "_cabinets");
        Directory.CreateDirectory(cabinetRoot);
        var cabinetFiles = Contained(cabinetRoot, "files");
        Directory.CreateDirectory(cabinetFiles);
        uint database;
        // MSIDBOPEN_READONLY is the null pointer (0), not a writable mode.
        Check(MsiOpenDatabaseW(Path.GetFullPath(archive), IntPtr.Zero, out database), "Open MSI read-only");
        try
        {
            var cabinets = new HashSet<string>(StringComparer.Ordinal);
            foreach (var row in Rows(database, "SELECT `Cabinet` FROM `Media`", 1))
            {
                if (row[0].Length == 0) continue;
                if (!row[0].StartsWith("#", StringComparison.Ordinal))
                    throw new InvalidDataException("External MSI cabinets are not supported");
                cabinets.Add(row[0].Substring(1));
            }
            uint streams;
            Check(MsiDatabaseOpenViewW(database, "SELECT `Name`, `Data` FROM `_Streams`", out streams), "Open MSI cabinet streams");
            try
            {
                Check(MsiViewExecute(streams, 0), "Read cabinet streams");
                uint record;
                uint result;
                int count = 0;
                while ((result = MsiViewFetch(streams, out record)) == 0)
                {
                    try
                    {
                        var name = Field(record, 1);
                        if (!cabinets.Remove(name)) continue;
                        var cab = Contained(cabinetRoot, (++count).ToString() + ".cab");
                        using (var file = File.Create(cab))
                        {
                            var buffer = new byte[65536];
                            while (true)
                            {
                                uint size = (uint)buffer.Length;
                                Check(MsiRecordReadStream(record, 2, buffer, ref size), "Extract MSI cabinet stream");
                                if (size == 0) break;
                                file.Write(buffer, 0, (int)size);
                            }
                        }
                        using (var verify = File.OpenRead(cab))
                        {
                            var header = new byte[4];
                            if (verify.Read(header, 0, 4) != 4 || Encoding.ASCII.GetString(header) != "MSCF")
                                throw new InvalidDataException("Invalid cabinet header: " + BitConverter.ToString(header));
                        }
                        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "expand.exe"));
                        start.Arguments = "-R \"" + cab + "\" -F:* \"" + cabinetFiles + "\"";
                        start.UseShellExecute = false;
                        start.CreateNoWindow = true;
                        start.RedirectStandardOutput = true;
                        start.RedirectStandardError = true;
                        using (var process = Process.Start(start))
                        {
                            var output = process.StandardOutput.ReadToEndAsync();
                            var error = process.StandardError.ReadToEndAsync();
                            process.WaitForExit();
                            System.Threading.Tasks.Task.WaitAll(output, error);
                            if (process.ExitCode != 0) throw new IOException("Cabinet expansion failed: " + error.Result);
                        }
                        File.Delete(cab);
                    }
                    finally { MsiCloseHandle(record); }
                }
                if (result != 259) Check(result, "Fetch MSI cabinet");
                if (cabinets.Count != 0) throw new InvalidDataException("Embedded MSI cabinet missing");
            }
            finally { MsiCloseHandle(streams); }

            var directories = new Dictionary<string, string[]>();
            foreach (var row in Rows(database, "SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`", 3))
                directories.Add(row[0], row);
            var components = new Dictionary<string, string>();
            foreach (var row in Rows(database, "SELECT `Component`, `Directory_` FROM `Component`", 2))
                components.Add(row[0], row[1]);
            var extracted = new List<string>();
            foreach (var row in Rows(database, "SELECT `File`, `Component_`, `FileName` FROM `File`", 3))
            {
                var source = Contained(cabinetFiles, row[0]);
                if (!File.Exists(source)) throw new FileNotFoundException("MSI file missing from cabinet: " + row[0], source);
                var directory = DirectoryPath(components[row[1]], directories, new HashSet<string>());
                var name = LongName(row[2]);
                var target = Contained(destination, Path.Combine(directory, name));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Move(source, target);
                extracted.Add(target);
            }
            if (Directory.GetFileSystemEntries(cabinetFiles).Length != 0)
                throw new InvalidDataException("Unmapped cabinet contents remain");
            Directory.Delete(cabinetFiles);
            Directory.Delete(cabinetRoot);
            return extracted.ToArray();
        }
        finally { MsiCloseHandle(database); }
    }
}
