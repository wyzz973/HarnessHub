"""Rejection fixtures for the planning validator; these are not runtime tests."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location("check_design", Path(__file__).with_name("check_design.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DesignChecks(unittest.TestCase):
    def records(self):
        req = {"requirements": [{"id": "R01"}]}
        task = {"application_implementation_allowed": False, "tasks": [
            {"id": "A", "title": "Accept input", "scope": "one command",
             "context": "interaction", "phase": "implementation", "gate": "G1",
             "status": "planned", "depends_on": [], "owns": ["src/accept.ts", "tests/unit/a.test.ts"],
             "requirements": ["R01"], "invariants": ["INV-01"],
             "acceptance": ["one durable input"], "out_of_scope": ["routing"], "test_cases": ["A-C01"]}
        ]}
        case = {"cases": [{"id": "A-C01", "task": "A", "requirements": ["R01"],
                          "invariants": ["INV-01"], "layer": "unit", "scenario": "same key",
                          "expected": "same input identity", "status": "planned", "evidence": None,
                          "planned_file": "tests/unit/a.test.ts"}]}
        return req, task, case

    def rejected(self, mutate, expected):
        records = copy.deepcopy(self.records())
        mutate(*records)
        errors = checker.check_plan(*records)
        self.assertTrue(any(expected in value for value in errors), errors)

    def test_accepts_valid_plan(self):
        self.assertEqual(checker.check_plan(*self.records()), [])

    def test_rejects_duplicate_task(self):
        self.rejected(lambda r, t, c: t["tasks"].append(copy.deepcopy(t["tasks"][0])), "duplicate task")

    def test_rejects_overlapping_owner(self):
        def mutate(r, t, c):
            other = copy.deepcopy(t["tasks"][0]); other["id"] = "B"; other["test_cases"] = ["B-C01"]
            t["tasks"].append(other)
            new = copy.deepcopy(c["cases"][0]); new["id"] = "B-C01"; new["task"] = "B"; c["cases"].append(new)
        self.rejected(mutate, "overlapping ownership")

    def test_rejects_file_directory_overlap(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["owns"].append("src/accept.ts/nested.ts"),
                      "file/directory ownership overlap")

    def test_rejects_dependency_cycle(self):
        def mutate(r, t, c):
            t["tasks"][0]["depends_on"] = ["B"]
            other = copy.deepcopy(t["tasks"][0]); other["id"] = "B"; other["depends_on"] = ["A"]
            other["owns"] = ["src/b.ts"]; t["tasks"].append(other)
        self.rejected(mutate, "dependency cycle")

    def test_rejects_missing_dependency(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["depends_on"].append("MISSING"), "invalid dependency")

    def test_rejects_missing_requirement_coverage(self):
        self.rejected(lambda r, t, c: r["requirements"].append({"id": "R02"}), "lacks a planned case")

    def test_rejects_case_outside_task(self):
        self.rejected(lambda r, t, c: c["cases"][0]["requirements"].append("R02"), "requirement outside task")

    def test_rejects_unowned_test_file(self):
        self.rejected(lambda r, t, c: c["cases"][0].update(planned_file="tests/foreign.test.ts"), "lacks unique task owner")

    def test_rejects_escaping_path(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["owns"].append("../foreign.ts"), "invalid ownership path")

    def test_rejects_wildcard_owner(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["owns"].append("src/**"), "invalid ownership path")

    def test_rejects_false_runtime_success(self):
        self.rejected(lambda r, t, c: c["cases"][0].update(status="passed", evidence="demo"), "cannot claim runtime")

    def test_rejects_open_implementation_gate(self):
        self.rejected(lambda r, t, c: t.update(application_implementation_allowed=True), "must remain closed")

    def test_rejects_missing_expected_result(self):
        self.rejected(lambda r, t, c: c["cases"][0].update(expected=""), "missing expected")

    def test_rejects_invalid_test_layer(self):
        self.rejected(lambda r, t, c: c["cases"][0].update(layer="green"), "invalid test layer")

    def test_rejects_incorrect_gate(self):
        self.rejected(lambda r, t, c: t["tasks"][0].update(gate="G0"), "inconsistent readiness gate")

    def test_rejects_progress_without_slice(self):
        self.rejected(lambda r, t, c: t["tasks"][0].update(status="in_progress"), "needs an approved slice")

    def test_rejects_deferred_work_without_reason(self):
        self.rejected(lambda r, t, c: t["tasks"][0].update(status="deferred"), "needs a reason")

    def test_rejects_case_insensitive_path_overlap(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["owns"].append("src/ACCEPT.ts"),
                      "overlapping ownership")

    def test_rejects_noncanonical_path(self):
        self.rejected(lambda r, t, c: t["tasks"][0]["owns"].append("src//accept.ts"),
                      "invalid ownership path")

    def file_fixture_errors(self, mutate=lambda root, views: None, verify_cache=False):
        with TemporaryDirectory(prefix="harness-design-check-") as directory:
            root = Path(directory)
            views = {"generated.md": "generated\n"}
            (root / "generated.md").write_text(views["generated.md"])
            (root / "docs/domain").mkdir(parents=True)
            (root / "docs/research").mkdir(parents=True)
            (root / "plan").mkdir()
            (root / "docs/domain/invariants.md").write_text("INV-01\n")
            source = {"repositories": [{"repo": "example/repo", "commit": "a" * 40,
                       "files": [{"path": "README.md", "sha256": "b" * 64, "bytes": 1,
                                  "url": "https://github.com/example/repo/blob/" + "a" * 40 + "/README.md"}]}]}
            (root / "docs/research/source-lock.json").write_text(json.dumps(source))
            (root / "plan/test-cases.json").write_text(json.dumps(self.records()[2]))
            mutate(root, views)
            return checker.check_files(root, views, verify_cache)

    def test_accepts_valid_design_files(self):
        self.assertEqual(self.file_fixture_errors(), [])

    def test_rejects_stale_view(self):
        errors = self.file_fixture_errors(lambda root, views: (root / "generated.md").write_text("stale\n"))
        self.assertTrue(any("stale generated view" in item for item in errors))

    def test_rejects_dead_local_link(self):
        errors = self.file_fixture_errors(lambda root, views: (root / "broken.md").write_text("[bad](missing.md)\n"))
        self.assertTrue(any("missing local link" in item for item in errors))

    def test_runtime_vendor_docs_do_not_enter_repository_link_checks(self):
        def mutate(root, views):
            for directory in ["data/vendor", "artifacts/fixture"]:
                file = root / directory / "README.md"
                file.parent.mkdir(parents=True)
                file.write_text("[vendor omitted file](absent.md)\n")
        self.assertEqual(self.file_fixture_errors(mutate), [])

    def test_named_data_directory_in_docs_still_rejects_dead_links(self):
        def mutate(root, views):
            file = root / "docs/data/README.md"
            file.parent.mkdir(parents=True)
            file.write_text("[bad](absent.md)\n")
        errors = self.file_fixture_errors(mutate)
        self.assertTrue(any("missing local link" in item for item in errors))

    def test_rejects_link_outside_project(self):
        errors = self.file_fixture_errors(lambda root, views: (root / "broken.md").write_text("[bad](../foreign.md)\n"))
        self.assertTrue(any("leaves project" in item for item in errors))

    def test_rejects_missing_source_cache(self):
        errors = self.file_fixture_errors(verify_cache=True)
        self.assertTrue(any("hash mismatch" in item for item in errors))

    def test_rejects_uncovered_invariant(self):
        errors = self.file_fixture_errors(lambda root, views: (root / "docs/domain/invariants.md").write_text("INV-01 INV-02\n"))
        self.assertTrue(any("lacks a planned case" in item for item in errors))

    def test_rejects_production_code_before_gate(self):
        errors = self.file_fixture_errors(lambda root, views: (root / "src").mkdir())
        self.assertTrue(any("implementation gate is closed" in item for item in errors))

    def approved_slice(self, root, views):
        (root / "src").mkdir()
        (root / "src/accept.ts").write_text("export const readonly = true;\n")
        (root / "decision.md").write_text("accepted read-only slice\n")
        records = self.records()[1]
        records["tasks"][0].update(status="in_progress", active_slice="read-only")
        (root / "plan/tasks.json").write_text(json.dumps(records))
        (root / "plan/slices.json").write_text(json.dumps({
            "gateway_execution_implementation_allowed": False,
            "slices": [{"id": "read-only", "status": "accepted", "task_ids": ["A"],
                        "decision": "decision.md", "allowed_files": ["src/accept.ts"]}]
        }))

    def test_accepts_only_owned_approved_source(self):
        self.assertEqual(self.file_fixture_errors(self.approved_slice), [])

    def test_rejects_source_outside_approved_slice(self):
        def mutate(root, views):
            self.approved_slice(root, views)
            (root / "src/execute.ts").write_text("unapproved\n")
        errors = self.file_fixture_errors(mutate)
        self.assertTrue(any("outside approved slice" in item for item in errors))

    def test_rejects_web_source_outside_approved_slice(self):
        def mutate(root, views):
            self.approved_slice(root, views)
            (root / "web").mkdir()
            (root / "web/App.tsx").write_text("unapproved\n")
        errors = self.file_fixture_errors(mutate)
        self.assertTrue(any("outside approved slice: web/App.tsx" in item for item in errors))

    def test_web_dist_exception_cannot_hide_nested_application_source(self):
        def mutate(root, views):
            self.approved_slice(root, views)
            (root / "web/src/dist").mkdir(parents=True)
            (root / "web/src/dist/hidden.ts").write_text("unapproved\n")
        errors = self.file_fixture_errors(mutate)
        self.assertTrue(any("outside approved slice: web/src/dist/hidden.ts" in item for item in errors))

    def test_rejects_unowned_slice_permission(self):
        def mutate(root, views):
            self.approved_slice(root, views)
            path = root / "plan/slices.json"
            data = json.loads(path.read_text())
            data["slices"][0]["allowed_files"].append("src/execute.ts")
            path.write_text(json.dumps(data))
        errors = self.file_fixture_errors(mutate)
        self.assertTrue(any("lacks task ownership" in item for item in errors))

    def matrix(self):
        complete = {"native": "yes", "source": "native schema", "hub": "done", "protocol": "pass", "real": "pass", "evidence": [".tmp/real.json"], "note": ""}
        absent = {"native": "no", "source": "native schema", "hub": "n/a", "protocol": "n/a", "real": "n/a", "evidence": [], "note": ""}
        return {"version": 1, "features": [{"id": "models", "group": "配置", "title": "模型"}, {"id": "audio", "group": "输入", "title": "音频"}],
                "harnesses": [{"id": "fixture", "name": "Fixture", "installation": "1.0", "control": "acp-v1",
                               "capabilities": {"models": complete, "audio": absent}}]}

    def matrix_rejected(self, mutate, expected):
        value = self.matrix(); mutate(value)
        errors = checker.check_capabilities(value)
        self.assertTrue(any(expected in item for item in errors), errors)

    def test_accepts_valid_capability_matrix(self):
        self.assertEqual(checker.check_capabilities(self.matrix()), [])
        view = checker.render_capabilities(self.matrix())
        self.assertIn("| 配置 | 模型 | ✅ |", view)
        self.assertIn("| 输入 | 音频 | — |", view)

    def test_rejects_missing_capability_cell(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"].pop("audio"), "cover exactly")

    def test_rejects_real_pass_without_evidence(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(evidence=[]), "needs evidence")

    def test_rejects_completion_without_protocol_test(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(protocol="none"), "needs protocol verification")

    def test_rejects_implemented_absent_capability(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["audio"].update(hub="done", protocol="pass"), "absent native capability")

    def test_rejects_unknown_native_claimed_done(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(native="unknown"), "unknown native capability")

    def test_rejects_blocked_without_reason(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(real="blocked"), "needs a reason")

    def test_rejects_native_claim_without_source(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(source=""), "needs a source")

    def test_rejects_invalid_capability_level(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(real="green"), "invalid capability level")

    def test_rejects_escaping_capability_evidence(self):
        self.matrix_rejected(lambda m: m["harnesses"][0]["capabilities"]["models"].update(evidence=["../outside.json"]), "project-relative")

    def test_rejects_missing_repository_evidence(self):
        value = self.matrix(); value["harnesses"][0]["capabilities"]["models"]["evidence"] = ["docs/missing.md"]
        with TemporaryDirectory(prefix="harness-matrix-") as directory:
            errors = checker.check_capabilities(value, Path(directory))
        self.assertTrue(any("evidence path is missing" in item for item in errors), errors)

    def test_partial_hub_never_renders_complete(self):
        value = self.matrix(); value["harnesses"][0]["capabilities"]["models"]["hub"] = "partial"
        self.assertEqual(checker.check_capabilities(value), [])
        self.assertIn("| 配置 | 模型 | ◑ |", checker.render_capabilities(value))

    def test_cli_returns_nonzero_for_invalid_plan(self):
        with TemporaryDirectory(prefix="harness-design-cli-") as directory:
            root = Path(directory)
            (root / "tools").mkdir(); (root / "plan").mkdir()
            script = root / "tools/check_design.py"
            shutil.copy2(Path(checker.__file__), script)
            records = self.records()
            records[1]["tasks"][0]["depends_on"] = ["missing"]
            for filename, record in zip(["requirements.json", "tasks.json", "test-cases.json"], records):
                (root / "plan" / filename).write_text(json.dumps(record))
            result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("invalid dependency", result.stderr)
            self.assertNotIn('"design_checks": "passed"', result.stdout)


if __name__ == "__main__":
    unittest.main()
