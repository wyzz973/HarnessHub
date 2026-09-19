"""Debug-only: time Git Bash invocations the way Hermes 0.19 starts them on Windows.

Each case records wall time until the process exits, whether it timed out (the whole
tree is then killed with taskkill /T /F), whether stdout reached EOF afterwards (a
grandchild holding the pipe makes subprocess.communicate() block forever) and the
output tail. Usage: python probe_bash.py BUNDLE OUT_DIR
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

CREATE_NO_WINDOW = 0x08000000
bundle, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
PROBE = "/usr/bin/true; /usr/bin/cat --version >/dev/null"


def process_table():
    try:
        text = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=60).stdout
        rows = json.loads(text)
        return rows if isinstance(rows, list) else [rows]
    except Exception as exc:  # debug helper only
        return [{"error": repr(exc)}]


def descendants(rows, root):
    found, frontier = [], {root}
    while frontier:
        nxt = set()
        for row in rows:
            if row.get("ParentProcessId") in frontier and row.get("ProcessId") not in frontier:
                found.append(row)
                nxt.add(row.get("ProcessId"))
        frontier = nxt
    return found


def run(name, argv, *, flags=CREATE_NO_WINDOW, stdin="devnull", env=None, timeout=20, cwd=None):
    record = {"name": name, "argv": argv, "flags": hex(flags), "stdin": stdin, "timeoutS": timeout}
    merged = dict(os.environ)
    merged.update(env or {})
    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if stdin == "pipe" else subprocess.DEVNULL,
            creationflags=flags, env=merged, cwd=cwd)
    except Exception as exc:
        record["spawnError"] = repr(exc)
        return record
    chunks, eof_at = [], []

    def reader():
        for chunk in iter(lambda: proc.stdout.read(4096), b""):
            chunks.append(chunk)
        eof_at.append(time.monotonic())

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    try:
        record["exit"] = proc.wait(timeout=timeout)
        record["timedOut"] = False
    except subprocess.TimeoutExpired:
        record["timedOut"] = True
        record["treeAtTimeout"] = descendants(process_table(), proc.pid)
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            record["exit"] = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            record["exit"] = "still running after taskkill"
    record["exitMs"] = round((time.monotonic() - start) * 1000)
    thread.join(timeout=5)
    record["stdoutEof"] = bool(eof_at)
    if eof_at:
        record["eofMs"] = round((eof_at[0] - start) * 1000)
    record["output"] = b"".join(chunks)[-1500:].decode("utf-8", "replace")
    print(json.dumps({k: record[k] for k in ("name", "exit", "timedOut", "exitMs", "stdoutEof")}), flush=True)
    return record


git = os.path.join(bundle, "bin", "git")
layout = {}
for rel in ["bin\\bash.exe", "usr\\bin\\bash.exe", "usr\\bin\\true.exe", "usr\\bin\\cat.exe", "git-bash.exe",
            "post-install.bat", "etc\\profile", "etc\\bash.bashrc", "etc\\fstab", "etc\\nsswitch.conf", "tmp"]:
    layout[rel] = os.path.exists(os.path.join(git, rel))
for rel in ["etc\\profile.d", "etc\\post-install"]:
    path = os.path.join(git, rel)
    layout[rel] = sorted(os.listdir(path)) if os.path.isdir(path) else None
bashes = {
    "bundle-usr": os.path.join(git, "usr", "bin", "bash.exe"),
    "bundle-bin": os.path.join(git, "bin", "bash.exe"),
    "system-usr": r"C:\Program Files\Git\usr\bin\bash.exe",
    "system-bin": r"C:\Program Files\Git\bin\bash.exe",
}
home = tempfile.mkdtemp(prefix="hh-home-")
private = {
    "HOME": home, "USERPROFILE": home,
    "APPDATA": os.path.join(home, "AppData", "Roaming"),
    "LOCALAPPDATA": os.path.join(home, "AppData", "Local"),
}
for value in private.values():
    os.makedirs(value, exist_ok=True)
work = tempfile.mkdtemp(prefix="hh-work-")
results = {"layout": layout, "bashes": {k: os.path.exists(v) for k, v in bashes.items()}, "cases": []}
for label, bash in bashes.items():
    if not os.path.exists(bash):
        continue
    cases = results["cases"]
    cases.append(run(f"{label}: _bash_starts probe (no window)", [bash, "--noprofile", "--norc", "-c", PROBE]))
    cases.append(run(f"{label}: _bash_starts probe (flags 0)", [bash, "--noprofile", "--norc", "-c", PROBE], flags=0))
    cases.append(run(f"{label}: -c echo", [bash, "-c", "echo hi"]))
    cases.append(run(f"{label}: -l -c echo", [bash, "-l", "-c", "echo hi"], timeout=40))
    cases.append(run(f"{label}: -l -c echo (private HOME)", [bash, "-l", "-c", "echo hi"], env=private, timeout=40))
    cases.append(run(f"{label}: -l -c echo (private HOME, stdin pipe)", [bash, "-l", "-c", "echo hi"], env=private, stdin="pipe", timeout=40))
    cases.append(run(f"{label}: -l -c export -p (private HOME, cwd work)", [bash, "-l", "-c", "export -p >/dev/null; pwd -P"], env=private, cwd=work, timeout=40))
with open(os.path.join(out, "probe-bash.json"), "w", encoding="utf-8") as handle:
    json.dump(results, handle, indent=2)
