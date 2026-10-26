"""Placement drift, result truth, and owned subprocess lifecycle regressions."""

import copy
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

SPEC = importlib.util.spec_from_file_location("breadth", Path(__file__).with_name("run-public-breadth.py"))
breadth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(breadth)
ROOT = Path(__file__).resolve().parent.parent


class BreadthTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".breadth-contract-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)

    def fixture(self):
        root = self.parent / "source"
        for directory in ("apps/form", "services/api", "packages", "scripts", ".github/workflows"):
            (root / directory).mkdir(parents=True)
        for name in (breadth.HELPER, breadth.CONTRACT_TEST, breadth.MANIFEST, "scripts/run-public-checks.py",
                     "scripts/run-public-checks.test.py", "scripts/native-impact.test.py", "scripts/ci-placement.test.py",
                     ".github/workflows/public-breadth.yml"):
            (root / name).write_bytes((ROOT / name).read_bytes())
        return root

    def contract(self, body):
        command = {"group": "fixture", "cwd": ".", "argv": [sys.executable, "-c", body],
                   "test_sources": ["synthetic.test.py"], "reporter": None}
        return {"commands": [command], "all_coverage_available": False}

    def test_partition_is_exhaustive_and_refuses_unknown_stale_or_overlapping_entries(self):
        contract = breadth.selection(ROOT)
        manifest = json.loads((ROOT / breadth.MANIFEST).read_text())
        discovered, hosted = contract["discovered_test_files"], contract["existing_hosted_test_files"]
        self.assertEqual(len(discovered), 295)
        self.assertEqual(len(hosted), 35)
        self.assertEqual(sum(len(g["files"]) for g in contract["blocked_groups"]), 32)
        self.assertFalse(contract["all_coverage_available"])
        for files in (discovered + ["scripts/new.test.py"], discovered[1:]):
            with self.assertRaisesRegex(ValueError, "Placement drift"):
                breadth.partition(ROOT, manifest, files, hosted)
        duplicate = copy.deepcopy(manifest)
        duplicate["groups"][-1]["files"].append(discovered[0])
        with self.assertRaisesRegex(ValueError, "Overlapping"):
            breadth.partition(ROOT, duplicate, discovered, hosted)
        with self.assertRaisesRegex(ValueError, "hosted selection changed"):
            breadth.partition(ROOT, manifest, discovered, hosted[1:])

    def test_commands_preserve_nested_voice_transport_and_adapter_selection(self):
        commands = breadth.selection(ROOT)["commands"]
        selected = {c["group"]: c for c in commands}
        self.assertEqual(len(selected["app-breadth"]["test_sources"]), 81)
        self.assertIn("src/api/tests/phone-signin.test.cjs", selected["app-breadth"]["argv"])
        self.assertNotIn("scripts/test-api-transport.cjs", selected["app-breadth"]["argv"])
        self.assertIn("tests/voice/portable-session.test.mjs", selected["website"]["argv"])
        self.assertEqual(selected["adapter-unit"]["argv"], ["node", "--test", "--test-reporter=tap",
                         "--test-concurrency=1", "tests/adapter.test.mjs", "tests/domain-ports.test.mjs",
                         "tests/mcp-handler.test.mjs", "tests/oauth-resource.test.mjs"])
        self.assertIn("--import", selected["api-breadth"]["argv"])
        self.assertIn("dist/tests/purchases/purchases.test.js", selected["api-breadth"]["argv"])
        self.assertNotIn("npm run build", json.dumps(commands))
        workflow = (ROOT / ".github/workflows/public-breadth.yml").read_text()
        self.assertIn("schedule:", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertIn("python3 -B scripts/run-public-breadth.py --install", workflow)
        self.assertIn("breadth-contract", selected)
        self.assertIn("persist-credentials: false", workflow)

    def test_counts_report_only_the_exact_apple_skip_as_documented_unavailable(self):
        log = self.parent / "tap.log"
        summary = "# pass 4\n# fail 0\n# skipped 1\n# todo 0\n"
        log.write_text(f"ok 5 - {breadth.APPLE_SKIP} # SKIP {breadth.APPLE_REASON}\n" + summary)
        command = {"group": "api-breadth", "reporter": "tap"}
        self.assertEqual(breadth.counts(command, log, self.parent)["documented_unavailable"], 1)
        log.write_text("ok 5 - another case # SKIP input missing\n" + summary)
        self.assertEqual(breadth.counts(command, log, self.parent)["documented_unavailable"], 0)
        log.write_text("no result\n")
        with self.assertRaisesRegex(ValueError, "Missing TAP"):
            breadth.counts(command, log, self.parent)

    def test_success_failure_and_unexpected_skip_preserve_receipts_and_remove_scratch(self):
        root = self.fixture()
        scenarios = [("print('done')", 0, None), ("raise SystemExit(7)", 7, None),
                     ("print('# pass 2\\n# fail 0\\n# skipped 1\\n# todo 0')", 1, "tap")]
        for index, (body, expected, reporter) in enumerate(scenarios):
            contract = self.contract(body)
            contract["commands"][0]["reporter"] = reporter
            output = self.parent / f"evidence-{index}"
            with patch.object(breadth.subprocess, "check_output", return_value="a" * 40), patch.object(breadth, "admit_storage", return_value={}):
                self.assertEqual(breadth.execute(root, output, contract), expected)
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertTrue(receipt["scratch_removed"])
            self.assertFalse(Path(receipt["scratch_root"]).exists())
            self.assertTrue((output / receipt["results"][0]["log"]).is_file())
            self.assertFalse(receipt["all_coverage_available"])

    def test_concurrent_workspace_ownership_and_storage_refusal(self):
        root = self.fixture()
        with breadth.owned_workspace(root, False) as outer:
            with breadth.owned_workspace(root, False) as inner:
                self.assertNotEqual(outer, inner)
            self.assertFalse(inner.exists())
            self.assertTrue(outer.exists())
        self.assertFalse(outer.exists())
        with patch.object(breadth.shutil, "disk_usage") as usage:
            usage.return_value.free = breadth.RESERVE_BYTES + breadth.ADDITIONAL_PEAK_BYTES - 1
            with self.assertRaisesRegex(OSError, "Storage admission refused"):
                breadth.admit_storage(root)

    def test_cleanup_failure_preserves_original_exit_status(self):
        root = self.fixture()
        original = breadth.tempfile.TemporaryDirectory.cleanup

        def cleanup_then_fail(temporary):
            original(temporary)
            raise OSError("synthetic cleanup failure")

        output = self.parent / "cleanup-evidence"
        with patch.object(breadth.subprocess, "check_output", return_value="a" * 40), patch.object(breadth, "admit_storage", return_value={}), patch.object(breadth.tempfile.TemporaryDirectory, "cleanup", cleanup_then_fail):
            self.assertEqual(breadth.execute(root, output, self.contract("raise SystemExit(7)")), 7)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["exit_status"], 7)
        self.assertIn("synthetic cleanup failure", receipt["error"])

    def test_handled_signals_terminate_child_and_preserve_evidence(self):
        root = self.fixture()
        for sig in (signal.SIGINT, signal.SIGTERM):
            ready = self.parent / f"ready-{sig}"
            output = self.parent / f"signal-evidence-{sig}"
            body = f"import os,time; from pathlib import Path; Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(30)"
            code = f"""
import importlib.util
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('breadth', {str(ROOT / breadth.HELPER)!r})
breadth = importlib.util.module_from_spec(spec); spec.loader.exec_module(breadth)
with patch.object(breadth.subprocess, 'check_output', return_value='a' * 40), patch.object(breadth, 'admit_storage', return_value={{}}):
    raise SystemExit(breadth.execute(Path({str(root)!r}), Path({str(output)!r}), {self.contract(body)!r}))
"""
            with (self.parent / f"signal-{sig}.log").open("w") as log:
                child = subprocess.Popen([sys.executable, "-B", "-c", code], stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 10
                    while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(ready.exists(), "fixture must start before cancellation")
                    child.send_signal(sig)
                    self.assertEqual(child.wait(timeout=15), 128 + sig)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertEqual(receipt["status"], "cancelled")
            self.assertTrue(receipt["scratch_removed"])
            with self.assertRaises(ProcessLookupError):
                os.kill(int(ready.read_text()), 0)


if __name__ == "__main__":
    unittest.main()
