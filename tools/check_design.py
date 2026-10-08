#!/usr/bin/env python3
"""Validate design records and generated views; never run application/Harness code."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import unicodedata


ROOT = Path(__file__).resolve().parents[1]
LAYERS = {"unit", "integration", "property", "protocol", "platform", "e2e",
          "security", "performance", "review", "probe"}


def check_plan(requirements: dict, task_plan: dict, test_plan: dict) -> list[str]:
    errors: list[str] = []
    reqs = requirements.get("requirements", [])
    tasks = task_plan.get("tasks", [])
    cases = test_plan.get("cases", [])
    if not reqs or not tasks or not cases:
        errors.append("requirements/tasks/cases must all be non-empty")
    if task_plan.get("application_implementation_allowed") is not False:
        errors.append("application implementation gate must remain closed in design phase")
    for name, items in [("requirement", reqs), ("task", tasks), ("case", cases)]:
        ids = [item.get("id") for item in items]
        if any(not isinstance(value, str) or not value for value in ids):
            errors.append(name + " has an invalid id")
        for value, count in Counter(ids).items():
            if count != 1:
                errors.append("duplicate " + name + " id: " + str(value))
    req_ids = {r.get("id") for r in reqs}
    task_ids = {t.get("id") for t in tasks}
    case_ids = {c.get("id") for c in cases}
    task_by_id = {t.get("id"): t for t in tasks}
    case_by_id = {c.get("id"): c for c in cases}
    owners: dict[str, str] = {}
    covered_reqs: set[str] = set()
    covered_invariants: set[str] = set()
    for task in tasks:
        tid = task.get("id", "?")
        for field in ["title", "scope", "context"]:
            if not isinstance(task.get(field), str) or not task[field].strip():
                errors.append(str(tid) + " missing " + field)
        if task.get("phase") not in {"verification", "contract", "implementation"}:
            errors.append(str(tid) + " invalid phase")
        if task.get("gate") != ("G0" if task.get("phase") in {"verification", "contract"} else "G1"):
            errors.append(str(tid) + " has inconsistent readiness gate")
        if task.get("status") != "planned":
            errors.append(str(tid) + " cannot be claimed done by a design check")
        for field in ["owns", "requirements", "acceptance", "test_cases", "out_of_scope"]:
            if not isinstance(task.get(field), list) or not task[field]:
                errors.append(str(tid) + " missing non-empty " + field)
        for dep in task.get("depends_on", []):
            if dep not in task_ids or dep == tid:
                errors.append(str(tid) + " invalid dependency " + str(dep))
        for rid in task.get("requirements", []):
            if rid not in req_ids:
                errors.append(str(tid) + " unknown requirement " + str(rid))
        for file in task.get("owns", []):
            if (not isinstance(file, str) or not file or
                PurePosixPath(file).is_absolute() or ".." in PurePosixPath(file).parts or
                any(char in file for char in "*?\\") or file.endswith("/") or
                PurePosixPath(file).as_posix() != file):
                errors.append(str(tid) + " invalid ownership path " + str(file))
                continue
            canonical = unicodedata.normalize("NFC", file).casefold()
            if canonical in owners:
                errors.append("overlapping ownership: " + file + " by " + owners[canonical] + "/" + str(tid))
            else:
                owners[canonical] = str(tid)
        for cid in task.get("test_cases", []):
            if cid not in case_ids or case_by_id[cid].get("task") != tid:
                errors.append(str(tid) + " mismatched case " + str(cid))
    paths = sorted(owners)
    for index, path in enumerate(paths):
        for other in paths[index + 1:]:
            if other.startswith(path + "/"):
                errors.append("file/directory ownership overlap: " + path + "/" + other)
    for case in cases:
        cid = case.get("id", "?")
        task = task_by_id.get(case.get("task"))
        if task is None:
            errors.append(str(cid) + " unknown task")
            continue
        for field in ["scenario", "expected"]:
            if not isinstance(case.get(field), str) or not case[field].strip():
                errors.append(str(cid) + " missing " + field)
        if case.get("layer") not in LAYERS:
            errors.append(str(cid) + " invalid test layer")
        if case.get("status") != "planned" or case.get("evidence") is not None:
            errors.append(str(cid) + " cannot claim runtime evidence in design phase")
        if cid not in task.get("test_cases", []):
            errors.append(str(cid) + " is not referenced by its task")
        if case.get("planned_file") not in task.get("owns", []):
            errors.append(str(cid) + " planned file lacks unique task owner")
        if not case.get("requirements"):
            errors.append(str(cid) + " has no requirement")
        for rid in case.get("requirements", []):
            if rid not in req_ids or rid not in task.get("requirements", []):
                errors.append(str(cid) + " requirement outside task: " + str(rid))
            covered_reqs.add(rid)
        covered_invariants.update(case.get("invariants", []))
    for rid in sorted(req_ids - covered_reqs):
        errors.append("requirement lacks a planned case: " + str(rid))
    # A cycle cannot be made valid by changing the display order of tasks.
    active: set[str] = set()
    visited: set[str] = set()

    def visit(tid: str) -> None:
        if tid in active:
            errors.append("dependency cycle at " + tid)
            return
        if tid in visited or tid not in task_by_id:
            return
        active.add(tid)
        for dep in task_by_id[tid].get("depends_on", []):
            visit(dep)
        active.remove(tid)
        visited.add(tid)

    for tid in task_ids:
        if isinstance(tid, str):
            visit(tid)
    return errors


def cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def render_views(requirements: dict, tasks: dict, cases: dict) -> dict[str, str]:
    req_lines = ["# 第一阶段需求清单", "", "生成自 plan/requirements.json；使用 python3 tools/check_design.py --write 更新。全部为待实现需求，来源为 user 或 derived，不表示代码已完成。", "",
                 "| ID | 需求 | 行为 | 来源 |", "|---|---|---|---|"]
    for req in requirements["requirements"]:
        req_lines.append("| " + " | ".join(cell(req[k]) for k in ["id", "title", "statement", "origin"]) + " |")
    task_lines = ["# 原子任务与唯一交付物", "", "生成自 plan/tasks.json；全部 planned。V 为受控验证/评审，C 为 G1 前的精确契约冻结，G 为应用实现任务。V008 汇总已冻结契约的就绪证据后才能开始 G 任务。文件路径是未来交付物，不表示文件已存在。结构检查证明依赖/路径关系，职责原子性仍需人工评审。", "",
                  "| ID | 职责 | 前置任务 | 门禁 |", "|---|---|---|---|"]
    for task in tasks["tasks"]:
        task_lines.append("| " + " | ".join([task["id"], cell(task["title"]), ", ".join(task["depends_on"]) or "无", task["gate"]]) + " |")
    for task in tasks["tasks"]:
        task_lines += ["", "## " + task["id"] + " " + task["title"], "",
                       "范围：" + task["scope"] + "。", "",
                       "依赖：" + (", ".join(task["depends_on"]) or "无") + "。需求：" + ", ".join(task["requirements"]) + "。", "",
                       "唯一交付物："]
        task_lines += ["- " + file for file in task["owns"]]
        task_lines += ["", "验收："] + ["- " + item for item in task["acceptance"]]
        task_lines += ["", "场景：" + ", ".join(task["test_cases"]) + "。", "",
                       "禁止范围：" + "；".join(task["out_of_scope"]) + "。"]
    case_lines = ["# 计划测试矩阵", "", "生成自 plan/test-cases.json。所有场景均 planned，尚未运行；关联不等于充分覆盖证明。真实存储/HTTP/IPC、外部夹具、真实 Harness/Provider 和各平台分别验收。", "",
                  "| 场景 | 所属任务 | 层 | 输入/交错 | 必须观察到的结果 |", "|---|---|---|---|---|"]
    for case in cases["cases"]:
        case_lines.append("| " + " | ".join(cell(case[k]) for k in ["id", "task", "layer", "scenario", "expected"]) + " |")
    return {"docs/product/requirements.md": "\n".join(req_lines) + "\n",
            "TASKS.md": "\n".join(task_lines) + "\n",
            "docs/engineering/test-matrix.md": "\n".join(case_lines) + "\n"}


def check_files(root: Path, views: dict[str, str], verify_cache: bool) -> list[str]:
    errors: list[str] = []
    for relative, expected in views.items():
        file = root / relative
        if not file.exists() or file.read_text() != expected:
            errors.append("missing/stale generated view: " + relative)
    for file in root.rglob("*.md"):
        if any(part in {".git", ".research-cache", ".tmp", "node_modules"} for part in file.parts):
            continue
        content = file.read_text()
        if content.startswith("\ufeff") or "\r" in content or not content.endswith("\n"):
            errors.append("invalid UTF-8/newline convention: " + str(file.relative_to(root)))
        # Only explicit inline local file links. No full CommonMark/HTML claim.
        for match in re.finditer(r"\]\(([^)]+)\)", content):
            link = match.group(1)
            if re.match(r"^[a-zA-Z][\w+.-]*:", link) or link.startswith("#"):
                continue
            target = link.split("#", 1)[0].strip("<>")
            destination = (file.parent / target).resolve()
            if root.resolve() not in [destination, *destination.parents]:
                errors.append("local link leaves project: " + target)
            elif not destination.exists():
                errors.append("missing local link: " + str(file.relative_to(root)) + " -> " + target)
    lock = json.loads((root / "docs/research/source-lock.json").read_text())
    if not lock.get("repositories"):
        errors.append("source lock is empty")
    for repo in lock["repositories"]:
        sha = repo.get("commit", "")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            errors.append("invalid source commit: " + repo.get("repo", "?"))
        for item in repo.get("files", []):
            if (not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")) or
                "/blob/" + sha + "/" not in item.get("url", "") or item.get("bytes", 0) <= 0):
                errors.append("invalid source snapshot metadata: " + item.get("path", "?"))
            if verify_cache:
                path = root / ".research-cache" / repo["repo"].replace("/", "__") / item["path"]
                if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                    errors.append("source cache missing/hash mismatch: " + str(path))
    for item in lock.get("web_documents", []):
        if not item.get("sha256") or item.get("error"):
            errors.append("unverified web snapshot: " + item.get("id", "?"))
        elif verify_cache:
            path = root / ".research-cache" / item["cache_path"]
            if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                errors.append("web source cache missing/hash mismatch: " + item["id"])
    invariants = set(re.findall(r"INV-\d+", (root / "docs/domain/invariants.md").read_text()))
    planned = set()
    for case in json.loads((root / "plan/test-cases.json").read_text())["cases"]:
        planned.update(case["invariants"])
    for missing in sorted(invariants - planned):
        errors.append("invariant lacks a planned case: " + missing)
    for unknown in sorted(planned - invariants):
        errors.append("unknown planned invariant: " + unknown)
    # No production scaffold may slip through a successful design-only check.
    for directory in ["src", "ui", "native"]:
        if (root / directory).exists():
            errors.append("application source exists while implementation gate is closed: " + directory)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="regenerate the three human-readable planning views")
    parser.add_argument("--verify-cache", action="store_true", help="require and hash-check the captured local research files")
    args = parser.parse_args()
    try:
        requirements = json.loads((ROOT / "plan/requirements.json").read_text())
        tasks = json.loads((ROOT / "plan/tasks.json").read_text())
        cases = json.loads((ROOT / "plan/test-cases.json").read_text())
        errors = check_plan(requirements, tasks, cases)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        views = render_views(requirements, tasks, cases)
        if args.write:
            for relative, content in views.items():
                path = ROOT / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
        errors += check_files(ROOT, views, args.verify_cache)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        print(json.dumps({"design_checks": "passed",
                          "requirements": len(requirements["requirements"]),
                          "tasks": len(tasks["tasks"]),
                          "planned_test_scenarios": len(cases["cases"]),
                          "application_implementation_allowed": False,
                          "runtime_tests_executed": 0,
                          "cache_verified": args.verify_cache}, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("Design check failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
