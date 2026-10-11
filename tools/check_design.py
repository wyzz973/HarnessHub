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
        if task.get("status") not in {"planned", "in_progress", "deferred"}:
            errors.append(str(tid) + " cannot be claimed done by a design check")
        if task.get("status") == "in_progress" and not task.get("active_slice"):
            errors.append(str(tid) + " in-progress work needs an approved slice")
        if task.get("status") == "deferred" and not task.get("defer_reason"):
            errors.append(str(tid) + " deferred work needs a reason")
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
        if case.get("status") not in {"planned", "deferred"} or case.get("evidence") is not None:
            errors.append(str(cid) + " cannot claim runtime evidence in design phase")
        if case.get("status") == "deferred" and not case.get("defer_reason"):
            errors.append(str(cid) + " deferred case needs a reason")
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


CAPABILITY_LEVELS = {
    "native": {"yes", "partial", "no", "unknown"},
    "hub": {"done", "partial", "none", "n/a"},
    "protocol": {"pass", "none", "n/a"},
    "real": {"pass", "partial", "fail", "blocked", "none", "n/a"},
}
CAPABILITY_FIELDS = {"native", "source", "hub", "protocol", "real", "evidence", "note"}
CAPABILITY_VIEW = "docs/verification/native-capability-matrix.md"


def check_capabilities(matrix: dict, root: Path | None = None) -> list[str]:
    """Per-Harness native capability claims. Completion needs native, Hub, protocol and real evidence."""
    errors: list[str] = []
    features, harnesses = matrix.get("features"), matrix.get("harnesses")
    if not isinstance(features, list) or not features or not isinstance(harnesses, list) or not harnesses:
        return ["capability matrix needs non-empty features and harnesses"]
    feature_ids: list[str] = []
    for feature in features:
        fid = feature.get("id") if isinstance(feature, dict) else None
        if not isinstance(fid, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,63}", fid):
            errors.append("invalid capability feature id: " + str(fid))
            continue
        if any(not isinstance(feature.get(field), str) or not feature[field].strip() for field in ["group", "title"]):
            errors.append("capability feature lacks group/title: " + fid)
        feature_ids.append(fid)
    for value, count in Counter(feature_ids).items():
        if count != 1:
            errors.append("duplicate capability feature: " + value)
    harness_ids: list[str] = []
    for harness in harnesses:
        hid = harness.get("id") if isinstance(harness, dict) else None
        if not isinstance(hid, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", hid):
            errors.append("invalid capability Harness id: " + str(hid))
            continue
        harness_ids.append(hid)
        for field in ["name", "installation", "control"]:
            if not isinstance(harness.get(field), str) or not harness[field].strip():
                errors.append(hid + " capability record lacks " + field)
        cells = harness.get("capabilities")
        if not isinstance(cells, dict) or set(cells) != set(feature_ids):
            errors.append(hid + " capabilities must cover exactly the declared features")
            continue
        for fid, entry in cells.items():
            label = hid + "/" + fid
            if not isinstance(entry, dict) or set(entry) - CAPABILITY_FIELDS:
                errors.append(label + " has unknown capability fields")
                continue
            values = {key: entry.get(key) for key in CAPABILITY_LEVELS}
            if any(values[key] not in allowed for key, allowed in CAPABILITY_LEVELS.items()):
                errors.append(label + " has an invalid capability level")
                continue
            native, hub, protocol, real = values["native"], values["hub"], values["protocol"], values["real"]
            evidence, note, source = entry.get("evidence", []), entry.get("note", ""), entry.get("source", "")
            if not isinstance(evidence, list) or any(not isinstance(item, str) or not item.strip() for item in evidence) or not isinstance(note, str) or not isinstance(source, str):
                errors.append(label + " has invalid evidence/note/source")
                continue
            if native != "unknown" and not source.strip():
                errors.append(label + " native observation needs a source")
            if native == "no" and (hub, protocol, real) != ("n/a", "n/a", "n/a"):
                errors.append(label + " absent native capability cannot be implemented or verified")
            if hub == "n/a" and native != "no":
                errors.append(label + " only an absent native capability is not applicable")
            if native == "unknown" and hub in {"done", "partial"}:
                errors.append(label + " unknown native capability cannot be claimed implemented")
            if hub == "done" and protocol != "pass":
                errors.append(label + " Hub-complete capability needs protocol verification")
            if protocol == "pass" and hub not in {"done", "partial"}:
                errors.append(label + " protocol verification needs a Hub implementation")
            if real in {"pass", "partial"} and hub not in {"done", "partial"}:
                errors.append(label + " real verification needs a Hub implementation")
            if real in {"pass", "partial"} and not evidence:
                errors.append(label + " real verification needs evidence")
            if real in {"fail", "blocked", "partial"} and not note.strip():
                errors.append(label + " incomplete real verification needs a reason")
            for item in evidence:
                path = PurePosixPath(item.split("#", 1)[0])
                if path.is_absolute() or ".." in path.parts:
                    errors.append(label + " evidence must be a project-relative path")
                elif root is not None and path.parts and path.parts[0] != ".tmp" and not (root / path).exists():
                    errors.append(label + " evidence path is missing: " + item)
    for value, count in Counter(harness_ids).items():
        if count != 1:
            errors.append("duplicate capability Harness: " + value)
    return errors


def capability_symbol(entry: dict) -> str:
    native, hub, protocol, real = entry["native"], entry["hub"], entry["protocol"], entry["real"]
    if native == "no":
        return "—"
    if native == "unknown":
        return "？"
    if real in {"fail", "blocked"}:
        return "✕"
    if native == "yes" and hub == "done" and protocol == "pass" and real == "pass":
        return "✅"
    if hub == "none":
        return "○"
    if hub == "done" and protocol == "pass":
        return "◐"
    return "◑"


def render_capabilities(matrix: dict) -> str:
    features, harnesses = matrix["features"], matrix["harnesses"]
    lines = ["# 逐Harness原生能力矩阵", "",
             "生成自 plan/native-capabilities.json；使用 python3 tools/check_design.py --write 更新。设计检查要求每个Harness覆盖全部能力项，"
             "完整（✅）必须同时满足原接口具备、Hub契约/执行/界面已接出、协议测试通过和本机原安装真实验收通过；其余状态均不算完整接入。", "",
             "图例：✅ 完整；◐ 已接出并通过协议测试，真实原安装未验收；◑ 部分接出；○ 原接口具备但Hub未接出；✕ 真实验收失败或受阻；— 原接口不提供；？ 未核实。", "",
             "| 分组 | 能力 | " + " | ".join(cell(item["name"]) for item in harnesses) + " |",
             "|---|---|" + "---|" * len(harnesses)]
    for feature in features:
        lines.append("| " + cell(feature["group"]) + " | " + cell(feature["title"]) + " | " +
                     " | ".join(capability_symbol(item["capabilities"][feature["id"]]) for item in harnesses) + " |")
    lines += ["", "| Harness | ✅ | ◐ | ◑ | ○ | ✕ | — | ？ |", "|---|---|---|---|---|---|---|---|"]
    for item in harnesses:
        counts = Counter(capability_symbol(item["capabilities"][feature["id"]]) for feature in features)
        lines.append("| " + cell(item["name"]) + " | " + " | ".join(str(counts.get(symbol, 0)) for symbol in ["✅", "◐", "◑", "○", "✕", "—", "？"]) + " |")
    names = {"yes": "具备", "partial": "部分", "no": "不提供", "unknown": "未核实", "done": "已接出", "none": "未接出",
             "n/a": "不适用", "pass": "通过", "fail": "失败", "blocked": "受阻"}
    for item in harnesses:
        lines += ["", "## " + item["name"], "", "原安装：" + item["installation"] + "；控制入口：" + item["control"] + "。", "",
                  "| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |", "|---|---|---|---|---|---|---|---|"]
        for feature in features:
            entry = item["capabilities"][feature["id"]]
            lines.append("| " + " | ".join([cell(feature["title"]), names[entry["native"]], cell(entry.get("source", "")) or "—",
                                             names[entry["hub"]], names[entry["protocol"]],
                                             "部分通过" if entry["real"] == "partial" else names[entry["real"]],
                                             cell("；".join(entry.get("evidence", []))) or "—", cell(entry.get("note", "")) or "—"]) + " |")
    return "\n".join(lines) + "\n"


def cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def render_views(requirements: dict, tasks: dict, cases: dict) -> dict[str, str]:
    req_lines = ["# 第一阶段需求清单", "", "生成自 plan/requirements.json；使用 python3 tools/check_design.py --write 更新。全部为待实现需求，来源为 user 或 derived，不表示代码已完成。", "",
                 "| ID | 需求 | 行为 | 来源 |", "|---|---|---|---|"]
    for req in requirements["requirements"]:
        req_lines.append("| " + " | ".join(cell(req[k]) for k in ["id", "title", "statement", "origin"]) + " |")
    task_lines = ["# 原子任务与唯一交付物", "", "生成自 plan/tasks.json。完整工程地图保留；当前小切片优先级与允许路径见 plan/slices.json 和 docs/engineering/mvp.md。V 为验证/评审，C 为契约，G 为实现。状态不代表真实验证通过，延期不算通过；路径也不表示均已存在。", "",
                  "| ID | 职责 | 前置任务 | 门禁 | 状态 |", "|---|---|---|---|---|"]
    for task in tasks["tasks"]:
        task_lines.append("| " + " | ".join([task["id"], cell(task["title"]), ", ".join(task["depends_on"]) or "无", task["gate"], task["status"]]) + " |")
    for task in tasks["tasks"]:
        task_lines += ["", "## " + task["id"] + " " + task["title"], "",
                       "范围：" + task["scope"] + "。", "",
                       "依赖：" + (", ".join(task["depends_on"]) or "无") + "。需求：" + ", ".join(task["requirements"]) + "。", "",
                       "唯一交付物："]
        task_lines += ["- " + file for file in task["owns"]]
        task_lines += ["", "验收："] + ["- " + item for item in task["acceptance"]]
        task_lines += ["", "场景：" + ", ".join(task["test_cases"]) + "。", "",
                       "禁止范围：" + "；".join(task["out_of_scope"]) + "。"]
    case_lines = ["# 计划测试矩阵", "", "生成自 plan/test-cases.json。这是完整规划，不作为运行测试结果；planned/deferred 均不算通过。当前切片的实际测试另见验证记录，关联也不等于充分覆盖证明。", "",
                  "| 场景 | 所属任务 | 层 | 输入/交错 | 必须观察到的结果 | 状态 |", "|---|---|---|---|---|---|"]
    for case in cases["cases"]:
        case_lines.append("| " + " | ".join(cell(case[k]) for k in ["id", "task", "layer", "scenario", "expected", "status"]) + " |")
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
        # Root runtime namespaces contain third-party installed documentation, not repository docs.
        if file.relative_to(root).parts[0] in {"data", "artifacts"}:
            continue
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
    # Only explicitly approved, task-owned slice paths can pass the source gate.
    allowed: set[str] = set()
    slice_file = root / "plan/slices.json"
    if slice_file.exists():
        slices = json.loads(slice_file.read_text())
        task_records = json.loads((root / "plan/tasks.json").read_text())["tasks"]
        by_id = {task["id"]: task for task in task_records}
        accepted_slices = {item["id"]: item for item in slices.get("slices", []) if item.get("status") == "accepted"}
        for task in task_records:
            if task.get("status") == "in_progress":
                active = accepted_slices.get(task.get("active_slice"))
                if active is None or task["id"] not in active.get("task_ids", []):
                    errors.append("in-progress task lacks accepted slice: " + task["id"])
        if slices.get("gateway_execution_implementation_allowed") is not False:
            errors.append("a local slice cannot unlock gateway execution")
        for item in slices.get("slices", []):
            if item.get("status") != "accepted":
                continue
            owned = {file for tid in item.get("task_ids", []) for file in by_id.get(tid, {}).get("owns", [])}
            decision = (root / item.get("decision", "")).resolve()
            if not decision.is_file() or root.resolve() not in decision.parents:
                errors.append("slice lacks a project decision")
            for file in item.get("allowed_files", []):
                if file not in owned:
                    errors.append("slice path lacks task ownership: " + file)
                else:
                    allowed.add(file)
    for directory in ["src", "ui", "native", "web"]:
        if (root / directory).exists():
            files = [file for file in (root / directory).rglob("*") if file.is_file() and not (directory == "web" and file.relative_to(root / directory).parts[0] == "dist")]
            if not files and not allowed:
                errors.append("application source exists while implementation gate is closed: " + directory)
            for file in files:
                relative = file.relative_to(root).as_posix()
                if relative not in allowed:
                    errors.append("application source outside approved slice: " + relative)
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
        matrix_file = ROOT / "plan/native-capabilities.json"
        matrix = json.loads(matrix_file.read_text()) if matrix_file.exists() else None
        if matrix is not None:
            errors += check_capabilities(matrix, ROOT)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        views = render_views(requirements, tasks, cases)
        if matrix is not None:
            views[CAPABILITY_VIEW] = render_capabilities(matrix)
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
                          "native_capability_cells": sum(len(item["capabilities"]) for item in matrix["harnesses"]) if matrix is not None else 0,
                          "native_capabilities_complete": sum(1 for item in matrix["harnesses"] for entry in item["capabilities"].values() if capability_symbol(entry) == "✅") if matrix is not None else 0,
                          "application_implementation_allowed": False,
                          "approved_slices": [item["id"] for item in json.loads((ROOT / "plan/slices.json").read_text()).get("slices", []) if item.get("status") == "accepted"] if (ROOT / "plan/slices.json").exists() else [],
                          "runtime_tests_executed_by_this_check": 0,
                          "cache_verified": args.verify_cache}, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("Design check failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
