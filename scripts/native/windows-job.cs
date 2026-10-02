using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// The helper is a separate process so closing the Gateway or helper cannot leak a Job handle.
// It does not implement filesystem, network, token, credential, or desktop isolation.
internal static class WindowsJob {
    const uint Synchronize = 0x00100000, ProcessSetQuota = 0x0100, ProcessTerminate = 0x0001;
    const uint JobQuery = 0x0004, JobTerminate = 0x0008, WaitObject = 0, StillActive = 259;
    const int ErrorFileNotFound = 2, ErrorAlreadyExists = 183;
    const uint KillOnJobClose = 0x2000, CreateSuspended = 0x00000004, CreateNoWindow = 0x08000000;

    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reserved2;
        public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
        public IntPtr process, thread;
        public uint processId, threadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
        public StartupInfo startup;
        public IntPtr attributes;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);

    static Exception Failure(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static void Check(bool ok, string operation) { if (!ok) throw Failure(operation); }
    static string JobName(string token) {
        Guid value;
        if (!Guid.TryParseExact(token, "D", out value)) throw new ArgumentException("Invalid Job identity");
        return "Local\\HarnessHub.Job." + value.ToString("D");
    }
    static IntPtr NewJob(string token) {
        IntPtr job = CreateJobObject(IntPtr.Zero, JobName(token));
        int error = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw Failure("CreateJobObject");
        if (error == ErrorAlreadyExists) { CloseHandle(job); throw new InvalidOperationException("Job identity already exists"); }
        ExtendedLimit limits = new ExtendedLimit();
        limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
        try { Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))), "SetInformationJobObject"); }
        catch { CloseHandle(job); throw; }
        return job;
    }
    static IntPtr ProcessHandle(string pid, uint access) {
        IntPtr handle = OpenProcess(access, false, uint.Parse(pid));
        if (handle == IntPtr.Zero) throw Failure("OpenProcess");
        return handle;
    }
    static void EmptyJob(IntPtr job, int timeout) {
        Check(TerminateJobObject(job, 1), "TerminateJobObject");
        Stopwatch time = Stopwatch.StartNew();
        for (;;) {
            Accounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
            if (accounting.ActiveProcesses == 0) return;
            if (time.ElapsedMilliseconds >= timeout) throw new TimeoutException("Job descendants did not exit before cleanup deadline");
            Thread.Sleep(10);
        }
    }
    static int Recover(string token, int timeout) {
        IntPtr job = OpenJobObject(JobQuery | JobTerminate, false, JobName(token));
        if (job == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == ErrorFileNotFound) return 0;
            throw Failure("OpenJobObject");
        }
        try { EmptyJob(job, timeout); return 0; }
        finally { CloseHandle(job); }
    }
    // Windows CRT argv encoding, including empty arguments, quotes and trailing backslashes.
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(character); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    static int Supervise(string[] args) {
        bool launch = args[0] == "run";
        IntPtr parent = IntPtr.Zero, child = IntPtr.Zero, job = IntPtr.Zero;
        ProcessInformation info = new ProcessInformation();
        bool assigned = false;
        try {
            parent = ProcessHandle(args[1], Synchronize);
            job = NewJob(args[launch ? 2 : 3]);
            if (launch) {
                StartupInfoEx startup = new StartupInfoEx();
                startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
                startup.startup.flags = 0x100;
                startup.startup.input = GetStdHandle(-10); startup.startup.output = GetStdHandle(-11); startup.startup.error = GetStdHandle(-12);
                foreach (IntPtr handle in new IntPtr[] { startup.startup.input, startup.startup.output, startup.startup.error })
                    if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Check(SetHandleInformation(handle, 1, 1), "SetHandleInformation");
                StringBuilder command = new StringBuilder();
                for (int i = 3; i < args.Length; i++) { if (i != 3) command.Append(' '); command.Append(Quote(args[i])); }
                UIntPtr attributeSize = UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                startup.attributes = Marshal.AllocHGlobal(checked((int)attributeSize.ToUInt64()));
                IntPtr jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized = false;
                try {
                    Check(InitializeProcThreadAttributeList(startup.attributes, 1, 0, ref attributeSize), "InitializeProcThreadAttributeList");
                    initialized = true;
                    Marshal.WriteIntPtr(jobValue, job);
                    // JOB_LIST makes creation + ownership atomic even if this launcher is killed during CreateProcess.
                    Check(UpdateProcThreadAttribute(startup.attributes, 0, new UIntPtr(0x2000D), jobValue, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute JobList");
                    Check(CreateProcess(args[3], command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateNoWindow | 0x80000, IntPtr.Zero, null, ref startup, out info), "CreateProcess");
                    child = info.process;
                    assigned = true;
                } finally {
                    if (initialized) DeleteProcThreadAttributeList(startup.attributes);
                    Marshal.FreeHGlobal(startup.attributes);
                    Marshal.FreeHGlobal(jobValue);
                }
            } else child = ProcessHandle(args[2], Synchronize | ProcessSetQuota | ProcessTerminate);
            if (!launch) {
                Check(AssignProcessToJobObject(job, child), "AssignProcessToJobObject");
                assigned = true;
            }
            if (WaitForSingleObject(parent, 0) == WaitObject) { EmptyJob(job, 5000); return 0; }
            if (launch) {
                if (ResumeThread(info.thread) == uint.MaxValue) throw Failure("ResumeThread");
            } else { Console.Out.WriteLine("ready"); Console.Out.Flush(); }
            uint waited = WaitForMultipleObjects(2, new IntPtr[] { parent, child }, false, uint.MaxValue);
            if (waited != WaitObject && waited != WaitObject + 1) throw Failure("WaitForMultipleObjects");
            uint childCode = 1;
            if (launch && waited == WaitObject + 1) Check(GetExitCodeProcess(child, out childCode), "GetExitCodeProcess");
            EmptyJob(job, 5000);
            if (!launch) { Console.Out.WriteLine("empty"); Console.Out.Flush(); }
            return launch ? unchecked((int)childCode) : 0;
        } finally {
            // A CreateProcess/Assign failure cannot leave the suspended child behind.
            if (launch && child != IntPtr.Zero && !assigned) { TerminateProcess(child, 1); WaitForSingleObject(child, 5000); }
            if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
            if (child != IntPtr.Zero) CloseHandle(child);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != IntPtr.Zero) CloseHandle(parent);
        }
    }
    public static int Main(string[] args) {
        try {
            if (args.Length == 3 && args[0] == "close") return Recover(args[1], int.Parse(args[2]));
            if (args.Length == 4 && args[0] == "attach") return Supervise(args);
            if (args.Length >= 4 && args[0] == "run") return Supervise(args);
            throw new ArgumentException("Expected attach, run, or close operation");
        } catch (Exception error) { Console.Error.WriteLine("Windows Job supervisor: " + error.Message); return 125; }
    }
}
