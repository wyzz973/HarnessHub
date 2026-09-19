"""Debug-only: drive Hermes' own LocalEnvironment (the terminal tool backend) with a
stack dump every 20 s, the way the terminal tool creates it. Usage (bundled Python):
python -I -B hermes_env.py BUNDLE OUT_DIR LABEL [private]
"""
import faulthandler
import logging
import os
import sys
import tempfile
import time

bundle, out, label = sys.argv[1], sys.argv[2], sys.argv[3]
private = len(sys.argv) > 4 and sys.argv[4] == "private"
os.makedirs(out, exist_ok=True)
stacks = open(os.path.join(out, f"hermes-env-{label}-stacks.txt"), "w", encoding="utf-8")
faulthandler.dump_traceback_later(20, repeat=True, file=stacks)
logging.basicConfig(level=logging.DEBUG, filename=os.path.join(out, f"hermes-env-{label}.log"),
                    format="%(asctime)s %(threadName)s %(name)s %(levelname)s %(message)s")
root = tempfile.mkdtemp(prefix=f"hh-{label}-")
os.environ["HERMES_GIT_BASH_PATH"] = os.path.join(bundle, "bin", "git", "usr", "bin", "bash.exe")
os.environ["HERMES_HOME"] = os.path.join(root, "hermes-home")
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
if private:
    home = os.path.join(root, "home")
    for key, value in {"HOME": home, "USERPROFILE": home,
                       "APPDATA": os.path.join(home, "AppData", "Roaming"),
                       "LOCALAPPDATA": os.path.join(home, "AppData", "Local")}.items():
        os.makedirs(value, exist_ok=True)
        os.environ[key] = value
work = os.path.join(root, "work")
os.makedirs(work, exist_ok=True)
start = time.monotonic()
from tools.environments import local  # noqa: E402


def mark(text):
    print(f"[{time.monotonic() - start:7.2f}s] {text}", flush=True)


mark(f"find_bash -> {local._find_bash()}")
mark(f"bash_starts cache {local._bash_starts_cache}")
env = local.LocalEnvironment(cwd=work, timeout=60)
mark(f"LocalEnvironment ready snapshot={env._snapshot_ready} prefer_nonlogin={env._prefer_nonlogin}")
result = env.execute("echo mock-ok > mock-ok.txt && echo done")
mark(f"execute -> {result!r}")
mark(f"marker exists: {os.path.exists(os.path.join(work, 'mock-ok.txt'))}")
