"""Debug-only: reproduce the Hermes Git Bash probe hang when Hermes' stdin is a pipe with a
pending read (as under ACP), without HarnessHub.

outer: python stdin_hang.py BUNDLE OUT MODE  - spawns itself as `inner` with stdin=PIPE that is
       held open and never written, like the Worker's ACP pipe.
inner: a reader thread blocks on stdin like the ACP transport, then MODE runs:
  raw       bash probe with inherited stdin, then with NUL stdin (10 s budget each)
  hermes-*  Hermes LocalEnvironment + execute in a thread (90 s budget, stacks every 30 s)
"""
import faulthandler
import os
import subprocess
import sys
import threading
import time

CREATE_NO_WINDOW = 0x08000000
PROBE = "/usr/bin/true; /usr/bin/cat --version >/dev/null"


def outer(bundle, out, mode):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"stdin-{mode}.txt")
    with open(path, "w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-B", os.path.abspath(__file__), bundle, out, mode, "inner"],
            stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, creationflags=CREATE_NO_WINDOW)
        try:
            proc.wait(timeout=150)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            log.write("\nOUTER: inner still running after 150 s; killed\n")
        proc.stdin.close()
    with open(path, encoding="utf-8") as log:
        print(log.read())


def inner(bundle, out, mode):
    started = time.monotonic()

    def mark(text):
        print(f"[{time.monotonic() - started:6.2f}s] {text}", flush=True)

    reader = threading.Thread(target=lambda: sys.stdin.buffer.read(1), daemon=True)
    reader.start()
    time.sleep(1)
    mark(f"reader thread blocked on stdin: {reader.is_alive()}")
    bash = os.path.join(bundle, "bin", "git", "usr", "bin", "bash.exe")
    if mode == "raw":
        for label, stdin in (("inherited stdin", None), ("NUL stdin", subprocess.DEVNULL)):
            began = time.monotonic()
            proc = subprocess.Popen([bash, "--noprofile", "--norc", "-c", PROBE], stdin=stdin,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    creationflags=CREATE_NO_WINDOW)
            try:
                code = proc.wait(timeout=10)
                mark(f"bash probe with {label}: exit {code} after {time.monotonic() - began:.2f}s")
            except subprocess.TimeoutExpired:
                mark(f"bash probe with {label}: STILL RUNNING after 10 s")
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        stacks = open(os.path.join(out, f"stdin-{mode}-stacks.txt"), "w", encoding="utf-8")
        faulthandler.dump_traceback_later(30, repeat=True, file=stacks)
        os.environ["HERMES_GIT_BASH_PATH"] = bash
        os.environ["HERMES_HOME"] = os.path.join(out, f"home-{mode}")
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        work = os.path.join(out, f"work-{mode}")
        os.makedirs(work, exist_ok=True)
        result = {}

        def run():
            from tools.environments import local
            env = local.LocalEnvironment(cwd=work, timeout=60)
            result["execute"] = env.execute("echo mock-ok > mock-ok.txt && echo done")
            result["probeCache"] = dict(local._bash_starts_cache)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        thread.join(90)
        mark(f"hermes terminal: {'HUNG after 90 s' if thread.is_alive() else result}")
        mark(f"marker exists: {os.path.exists(os.path.join(work, 'mock-ok.txt'))}")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 4 and sys.argv[4] == "inner":
        inner(sys.argv[1], sys.argv[2], sys.argv[3])
    else:
        outer(sys.argv[1], sys.argv[2], sys.argv[3])
