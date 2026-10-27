"""Public group selection and observable subprocess/scratch lifecycle checks."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("public_checks", Path(__file__).with_name("run-public-checks.py"))
checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checks)
ROOT = Path(__file__).resolve().parent.parent


class PublicChecksTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="public-contract-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / "source"
        for directory in ("apps/form", "services/api", "packages", "scripts"):
            (self.root / directory).mkdir(parents=True)
        for name in (checks.HELPER, checks.HARNESS_TEST):
            (self.root / name).write_text((ROOT / name).read_text())

    def contract(self, body, second=False):
        command = {"group": "fixture", "cwd": ".", "argv": [sys.executable, "-c", body], "test_sources": []}
        return {"groups": ["fixture"], "commands": [command] * (2 if second else 1)}

    def execute(self, body, **kwargs):
        output = self.parent / "evidence"
        with patch.object(checks.subprocess, "check_output", return_value="a" * 40):
            status = checks.execute(self.root, output, self.contract(body, **kwargs))
        return status, json.loads((output / "receipt.json").read_text())

    def test_exact_groups_and_fresh_api_interop_dependency(self):
        contract = checks.selection(ROOT, ["form196", "form208"])
        self.assertEqual(contract["groups"], ["api-compile", "form196", "form208"])
        self.assertEqual(len(contract["manifest_sha256"]), 64)
        self.assertTrue(any("dist/tests/community/board/persistence-races.test.js" in c["argv"] for c in contract["commands"]))
        self.assertEqual(contract, checks.selection(ROOT, ["form208", "form196"]))

    def test_lifecycle_runtime_compiles_first_and_requires_candidate_coverage(self):
        contract = checks.selection(ROOT, ["lifecycle-runtime"])
        self.assertEqual(contract["groups"], ["api-compile", "lifecycle-runtime"])
        command = contract["commands"][1]
        for source in ("tests/lifecycle-purge-executor.test.ts",
                       "tests/bug-intake/lifecycle-chain.test.ts",
                       "tests/usage-limits/lifecycle.test.ts",
                       "tests/runtime-modules/relocated-admission.test.ts",
                       "tests/runtime-modules/restore-drill.test.ts",
                       "tests/integration/account-modules/canonical-writer.test.ts"):
            self.assertIn("dist/" + source.removesuffix(".ts") + ".js", command["argv"])
        self.assertIn("--test-concurrency=1", command["argv"])
        for selected in contract["commands"]:
            for source in selected["test_sources"]:
                path = self.root / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
        self.assertEqual(checks.selection(self.root, ["lifecycle-runtime"]), contract)
        (self.root / "services/api/tests/runtime-modules/restore-drill.test.ts").unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["lifecycle-runtime"])

    def test_health_discovery_includes_new_branch_tests_and_refuses_missing_baseline(self):
        for source in checks.BASELINE_HEALTH:
            target = self.root / checks.API / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        for source in (checks.SOURCE_HOOK, checks.SOURCE_RESOLVER):
            target = self.root / checks.API / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        for relative in ("tests/wearables/direct-connections/direct-connections.test.mjs", "tests/direct-provider-transport/bootstrap.test.mjs"):
            target = self.root / checks.API / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        contract = checks.selection(self.root, ["form104-139"])
        sources = contract["commands"][0]["test_sources"]
        self.assertEqual(len(sources), len(checks.BASELINE_HEALTH) + 4)
        self.assertIn(f"{checks.API}/tests/direct-provider-transport/bootstrap.test.mjs", sources)
        (self.root / checks.API / checks.BASELINE_HEALTH[0]).unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["form104-139"])

    def test_selected_health_hook_loads_api_and_app_source_imports(self):
        command = checks.selection(ROOT, ["form104-139"])["commands"][0]
        prefix = command["argv"][:command["argv"].index("--test")]
        source = lambda relative: (ROOT / relative).as_uri()
        script = f"""
            import assert from 'node:assert/strict';
            import {{ DomainError }} from {json.dumps(source('services/api/src/errors.ts'))};
            import {{ suppressionAuthority }} from {json.dumps(source('services/api/src/lifecycle/guards.ts'))};
            import {{ createHealthImport }} from {json.dumps(source('apps/form/src/wearables/importer.ts'))};
            import {{ createHealthPurgeConsumer }} from {json.dumps(source('apps/form/src/wearables/purge-intent.ts'))};
            assert.equal(typeof createHealthImport, 'function');
            assert.equal(typeof createHealthPurgeConsumer, 'function');
            assert.throws(() => suppressionAuthority({{}}), error =>
                error instanceof DomainError && error.code === 'suppression_authority_required');
        """
        child = subprocess.run([*prefix, "--input-type=module", "--eval", script],
                               cwd=ROOT / command["cwd"], text=True, capture_output=True, timeout=10)
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)

    def test_native_backend_and_app_groups_compile_first_and_require_every_input(self):
        contract = checks.selection(ROOT, ["native-e2e-backend", "native-e2e-app"])
        self.assertEqual(contract["groups"], ["api-compile", "native-e2e-backend", "native-e2e-app"])
        self.assertEqual(contract["commands"][1]["argv"], ["node", "--test", "--test-concurrency=1", "dist/tests/e2e/native-backend.test.js"])
        self.assertEqual(contract["commands"][2]["argv"][3:], list(checks.APP_TESTS["native-e2e-app"]))
        required = contract["commands"][1]["test_sources"]
        self.assertIn("services/api/tests/e2e/native-backend.ts", required)
        self.assertIn(f"services/api/{checks.SOURCE_HOOK}", required)
        for command in contract["commands"]:
            for source in command["test_sources"]:
                path = self.root / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
        self.assertEqual(checks.selection(self.root, ["native-e2e-backend", "native-e2e-app"]), contract)
        (self.root / "services/api/tests/e2e/native-backend.test.ts").unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["native-e2e-backend"])

    def test_native_app_group_requires_onboarding_renderer_regression(self):
        contract = checks.selection(ROOT, ["native-e2e-app"])
        renderer = "apps/form/tests/renderer/onboarding-save.test.tsx"
        commands = [command for command in contract["commands"] if renderer in command["test_sources"]]
        self.assertEqual(len(commands), 1, "Native app qualification must include the onboarding renderer regression")
        self.assertEqual(commands[0]["cwd"], "apps/form")
        self.assertEqual(commands[0]["argv"], ["npm", "run", "test:renderer", "--", "--runTestsByPath",
                                               "tests/renderer/onboarding-save.test.tsx"])
        self.assertIn("apps/form/jest.config.cjs", commands[0]["test_sources"])
        for command in contract["commands"]:
            for source in command["test_sources"]:
                path = self.root / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
        self.assertEqual(checks.selection(self.root, ["native-e2e-app"]), contract)
        (self.root / renderer).unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["native-e2e-app"])

    def test_simulator_portable_requires_both_driver_and_e2e_helper_tests(self):
        contract = checks.selection(ROOT, ["simulator-portable"])
        self.assertEqual([command["argv"][2] for command in contract["commands"]],
                         ["scripts/ci-ios-simulator.test.py", "scripts/ios_e2e.test.py"])
        for command in contract["commands"]:
            for source in command["test_sources"]:
                path = self.root / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
        (self.root / "apps/form/scripts/ios_e2e.test.py").unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["simulator-portable"])

    def test_success_cleans_child_outputs_and_preserves_log_and_receipt(self):
        status, receipt = self.execute("from pathlib import Path; Path('child-output').mkdir(); print('public proof')")
        self.assertEqual(status, 0)
        self.assertEqual(receipt["status"], "passed")
        self.assertTrue(receipt["scratch_removed"])
        self.assertFalse(Path(receipt["scratch_root"]).exists())
        self.assertIn("public proof", (self.parent / "evidence" / receipt["results"][0]["log"]).read_text())
        self.assertFalse((self.root / "child-output").exists())

    def test_failure_keeps_exit_code_and_evidence_and_does_not_run_later_commands(self):
        status, receipt = self.execute("from pathlib import Path; Path('partial').write_text('owned'); print('failure proof'); raise SystemExit(23)", second=True)
        self.assertEqual(status, 23)
        self.assertEqual(receipt["status"], "failed")
        self.assertTrue(receipt["scratch_removed"])
        self.assertEqual(len(receipt["results"]), 1)
        self.assertEqual(len(receipt["not_run"]), 1)
        self.assertIn("failure proof", (self.parent / "evidence" / receipt["results"][0]["log"]).read_text())

    def test_cleanup_error_preserves_primary_child_failure_and_fails_success(self):
        original = checks.tempfile.TemporaryDirectory.cleanup
        def remove_then_report(temporary):
            original(temporary)
            raise OSError("fixture cleanup error")
        with patch.object(checks.tempfile.TemporaryDirectory, "cleanup", remove_then_report):
            status, receipt = self.execute("raise SystemExit(7)")
        self.assertEqual(status, 7)
        self.assertEqual(receipt["results"][0]["returncode"], 7)
        self.assertIn("fixture cleanup error", receipt["error"])
        with patch.object(checks.tempfile.TemporaryDirectory, "cleanup", remove_then_report), patch.object(checks.subprocess, "check_output", return_value="a" * 40):
            status = checks.execute(self.root, self.parent / "success-cleanup-error", self.contract("pass"))
        self.assertEqual(status, 1)

    def test_nested_invocations_remove_only_their_own_workspace(self):
        for directory in (checks.API, checks.APP):
            dependencies = self.root / directory / "node_modules"
            dependencies.mkdir()
            (dependencies / "sentinel").write_text("preserve installed dependencies")
            generated = self.root / directory / "dist"
            generated.mkdir()
            (generated / "foreign").write_text("preserve unrelated build")
        with checks.owned_workspace(self.root, False) as first:
            with checks.owned_workspace(self.root, False) as second:
                self.assertNotEqual(first, second)
                self.assertFalse((second / checks.API / "dist").exists())
                (first / "owned").write_text("first")
                self.assertTrue((second / checks.API / "node_modules").is_symlink())
            self.assertFalse(second.exists())
            self.assertEqual((first / "owned").read_text(), "first")
        self.assertFalse(first.exists())
        self.assertEqual((self.root / checks.API / "dist/foreign").read_text(), "preserve unrelated build")
        self.assertEqual((self.root / checks.APP / "node_modules/sentinel").read_text(), "preserve installed dependencies")

    def test_sigint_and_sigterm_stop_owned_process_group_and_clean_workspace(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                output = self.parent / f"signal-{sig}"
                ready = self.parent / f"ready-{sig}"
                body = ("import os,time; from pathlib import Path; "
                        f"Path({str(ready)!r}).write_text(str(os.getpid())); "
                        "Path('partial-child-output').write_text('owned'); time.sleep(60)")
                program = ("import importlib.util; from pathlib import Path; from unittest.mock import patch; "
                           f"s=importlib.util.spec_from_file_location('checks', {str(ROOT / checks.HELPER)!r}); "
                           "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                           f"p=patch.object(m.subprocess, 'check_output', return_value={'a' * 40!r}); p.start(); "
                           f"raise SystemExit(m.execute(Path({str(self.root)!r}), Path({str(output)!r}), {self.contract(body)!r}))")
                child = subprocess.Popen([sys.executable, "-B", "-c", program], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 10
                    while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(ready.exists(), "fixture did not start")
                    command_pid = int(ready.read_text())
                    child.send_signal(sig)
                    child.communicate(timeout=15)
                    self.assertEqual(child.returncode, 128 + sig)
                    receipt = json.loads((output / "receipt.json").read_text())
                    self.assertEqual(receipt["status"], "cancelled")
                    self.assertEqual(receipt["results"][0]["status"], "interrupted")
                    self.assertTrue(receipt["scratch_removed"])
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(command_pid, 0)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
