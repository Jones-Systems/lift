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

    def test_health_discovery_includes_new_branch_tests_and_refuses_missing_baseline(self):
        for source in checks.BASELINE_HEALTH:
            target = self.root / checks.API / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        hook = self.root / checks.API / "tests/wearables/persistence/resolve.mjs"
        hook.write_text("")
        for relative in ("tests/wearables/direct-connections/direct-connections.test.mjs", "tests/direct-provider-transport/bootstrap.test.mjs"):
            target = self.root / checks.API / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        contract = checks.selection(self.root, ["form104-139"])
        sources = contract["commands"][0]["test_sources"]
        self.assertEqual(len(sources), len(checks.BASELINE_HEALTH) + 3)
        self.assertIn(f"{checks.API}/tests/direct-provider-transport/bootstrap.test.mjs", sources)
        (self.root / checks.API / checks.BASELINE_HEALTH[0]).unlink()
        with self.assertRaises(FileNotFoundError):
            checks.selection(self.root, ["form104-139"])

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
