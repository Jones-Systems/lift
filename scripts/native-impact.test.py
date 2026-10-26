"""Portable native input and workflow contracts; no product code is executed."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_impact", ROOT / "scripts/native-impact.py")
impact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(impact)
WORKFLOW = (ROOT / impact.WORKFLOW).read_text()
FIXTURES = contextlib.ExitStack()


def git(repo, *args, data=None):
    with subprocess.Popen(["git", "-c", "commit.gpgsign=false", "-c",
                           "core.hooksPath=/dev/null", "-C", str(repo), *args], text=True,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE) as process:
        try:
            stdout, stderr = process.communicate(data, timeout=15)
        except BaseException:
            process.kill()
            process.wait()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr)
        return stdout.strip()


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-impact-", dir=ROOT / "scripts")
        FIXTURES.callback(self.temp.cleanup)
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)
        self.source = self.parent / "source"
        self.source.mkdir()
        git(self.source, "init", "--quiet", "--template=", "--initial-branch=fixture")
        git(self.source, "config", "user.email", "fixture@example.invalid")
        git(self.source, "config", "user.name", "Native fixture")
        self.write(self.source, "apps/form/index.ts", "export const value = 1;\n")
        self.write(self.source, "apps/form/package.json", '{"dependencies":{}}\n')
        self.write(self.source, "apps/form/scripts/driver.py", "raise AssertionError('do not execute')\n")
        self.write(self.source, "services/api/index.ts", "export {};\n")
        self.write(self.source, ".gitattributes", "* text=auto\n")
        self.write(self.source, impact.WORKFLOW, WORKFLOW)
        self.write(self.source, impact.HELPER, (ROOT / impact.HELPER).read_text())
        self.write(self.source, impact.TEST, "# fixture self-test\n")
        self.base = self.commit(self.source)
        self.write(self.source, "head-only.txt", "head\n")
        head = self.commit(self.source)
        self.tooling = self.parent / "tooling"
        git(self.parent, "clone", "--quiet", "--no-hardlinks", str(self.source), str(self.tooling))
        git(self.tooling, "config", "user.email", "fixture@example.invalid")
        git(self.tooling, "config", "user.name", "Native fixture")
        self.env = {"SOURCE_SHA": head, "GITHUB_REPOSITORY": "Jones-Systems/lift",
                    "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REF": "refs/pull/42/merge",
                    "GITHUB_WORKFLOW_REF": "Jones-Systems/lift/" + impact.WORKFLOW + "@refs/pull/42/merge"}
        self.event = {"number": 42, "action": "synchronize", "pull_request": {
            "head": {"sha": head, "repo": {"full_name": "Jones-Systems/lift"}},
            "base": {"sha": self.base, "ref": "build/lift", "repo": {"full_name": "Jones-Systems/lift"}}}}
        self.merge()

    def write(self, repo, path, text):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, repo):
        git(repo, "add", "--all")
        git(repo, "commit", "--quiet", "--allow-empty", "-m", "fixture", "--no-gpg-sign")
        return git(repo, "rev-parse", "HEAD")

    def merge(self):
        git(self.tooling, "fetch", "--quiet", str(self.source), self.env["SOURCE_SHA"])
        git(self.tooling, "add", "--all")
        tree = git(self.tooling, "write-tree")
        sha = git(self.tooling, "commit-tree", tree, "-p", self.base,
                  "-p", self.env["SOURCE_SHA"], data="fixture merge\n")
        git(self.tooling, "update-ref", "HEAD", sha)
        self.env.update(GITHUB_SHA=sha, GITHUB_WORKFLOW_SHA=sha)

    def source_changed(self):
        sha = self.commit(self.source)
        self.env["SOURCE_SHA"] = sha
        self.event["pull_request"]["head"]["sha"] = sha
        self.merge()

    def observe(self):
        return impact.observe(self.source, self.tooling, self.env, self.event,
                              self.tooling / impact.HELPER)

    def assert_full(self, result):
        self.assertEqual((result["mode"], result["identity_status"], result["reuse"]),
                         ("full", "unknown", "unknown"))

    def test_stable_domain_separated_and_explicit_provenance(self):
        result = self.observe()
        self.assert_full(result)
        self.assertRegex(result["input_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(result, self.observe())
        content = {key: value for key, value in result["record"].items() if key != "provenance"}
        self.assertEqual(result["input_digest"], impact.fingerprint(content))
        self.assertNotEqual(result["input_digest"], impact.fingerprint(content, b"other\0"))
        self.assertEqual(result["record_digest"], impact.fingerprint(result["record"], impact.RECORD_DOMAIN))
        self.assertEqual(result["record"]["provenance"]["source_sha"], self.env["SOURCE_SHA"])
        self.assertNotEqual(self.env["SOURCE_SHA"], self.env["GITHUB_SHA"])
        for section, key in (("provenance", "source_sha"), ("provenance", "tooling_sha"),
                             ("provenance", "workflow_sha"), ("provenance", "base_sha")):
            changed = copy.deepcopy(result["record"])
            changed[section][key] = "a" * 40
            self.assertNotEqual(result["record_digest"], impact.fingerprint(changed, impact.RECORD_DOMAIN))

    def test_same_content_across_heads_retains_fingerprint_and_changes_provenance(self):
        before = self.observe()
        self.write(self.source, "README.md", "docs only\n")
        self.source_changed()
        after = self.observe()
        self.assertEqual(before["input_digest"], after["input_digest"])
        self.assertNotEqual(before["record_digest"], after["record_digest"])
        self.assert_full(after)

    def test_every_input_changes_digest(self):
        for repo, path, key in (
                (self.source, "apps/form/index.ts", "head_app"),
                (self.source, ".gitattributes", "head_attributes"),
                (self.tooling, "apps/form/scripts/driver.py", "tooling_driver"),
                (self.tooling, impact.WORKFLOW, "tooling_workflow"),
                (self.tooling, impact.HELPER, "tooling_helper"),
                (self.tooling, impact.TEST, "tooling_self_test")):
            with self.subTest(path=path):
                before = self.observe()
                with (repo / path).open("a") as stream:
                    stream.write("\n# changed\n")
                self.source_changed() if repo == self.source else self.merge()
                after = self.observe()
                self.assert_full(after)
                self.assertTrue(after["input_digest"])
                self.assertNotEqual(before["input_digest"], after["input_digest"])
                self.assertNotEqual(before["record"]["inputs"][key], after["record"]["inputs"][key])

    def test_head_app_and_merge_tooling_are_not_conflated(self):
        before = self.observe()
        self.write(self.tooling, "apps/form/index.ts", "merge app is not the built app\n")
        self.write(self.source, "apps/form/scripts/driver.py", "head driver is not executed\n")
        self.source_changed()
        after = self.observe()
        self.assertEqual(before["record"]["inputs"]["tooling_driver"], after["record"]["inputs"]["tooling_driver"])
        self.assertEqual(after["record"]["inputs"]["head_app"]["oid"],
                         git(self.source, "rev-parse", "HEAD:apps/form"))
        self.assertNotEqual(after["record"]["inputs"]["head_app"]["oid"],
                            git(self.tooling, "rev-parse", "HEAD:apps/form"))

    def test_absent_attributes_are_distinct_from_empty(self):
        (self.source / ".gitattributes").unlink()
        self.source_changed()
        absent = self.observe()
        self.assert_full(absent)
        self.assertEqual(absent["record"]["inputs"]["head_attributes"]["state"], "absent")
        self.write(self.source, ".gitattributes", "")
        self.source_changed()
        self.assertNotEqual(absent["input_digest"], self.observe()["input_digest"])

    def test_bad_refs_events_and_provenance_fail_closed(self):
        for key, value in (("SOURCE_SHA", "missing"), ("SOURCE_SHA", "f" * 40),
                           ("GITHUB_SHA", self.base), ("GITHUB_WORKFLOW_SHA", self.base),
                           ("GITHUB_REF", "refs/heads/wrong"),
                           ("GITHUB_WORKFLOW_REF", "other/workflow@ref"),
                           ("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_EVENT_NAME", "push")):
            with self.subTest(key=key, value=value):
                env = {**self.env, key: value}
                result = impact.observe(self.source, self.tooling, env, self.event)
                self.assert_full(result)
                self.assertEqual(result["input_digest"], "")
        for event in ({}, None, {"number": 42}, {**self.event, "action": "closed"}):
            self.assertEqual(impact.observe(self.source, self.tooling, self.env, event)["input_digest"], "")
        self.event["pull_request"]["base"]["sha"] = "e" * 40
        self.assertEqual(self.observe()["reason"], "merge-parent-mismatch")

    def test_manual_dispatch_still_full_with_explicit_source(self):
        self.env.update(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/build/lift",
                        GITHUB_WORKFLOW_REF="Jones-Systems/lift/" + impact.WORKFLOW + "@refs/heads/build/lift")
        self.event = {"inputs": {"source_sha": self.env["SOURCE_SHA"]}}
        self.assert_full(self.observe())
        self.assertTrue(self.observe()["input_digest"])
        self.event = {"inputs": {}}
        self.assertEqual(self.observe()["input_digest"], "")
        self.event = {"inputs": []}
        self.assertEqual(self.observe()["input_digest"], "")

    def test_missing_path_wrong_type_and_modes(self):
        target = self.tooling / impact.WORKFLOW
        target.unlink()
        self.merge()
        self.assertEqual(self.observe()["input_digest"], "")
        target.mkdir()
        (target / "nested").write_text("not a workflow")
        self.merge()
        self.assertEqual(self.observe()["input_digest"], "")
        (target / "nested").unlink()
        target.rmdir()
        target.write_text(WORKFLOW)
        target.chmod(0o755)
        self.merge()
        self.assertEqual(self.observe()["input_digest"], "")

    def test_symlink_and_submodule_fail_closed_without_reading_target(self):
        link = self.source / "apps/form/escape"
        link.symlink_to("/must-not-read-this")
        self.source_changed()
        self.assertEqual(self.observe()["reason"], "unsupported-tree-entry")
        link.unlink()
        self.source_changed()
        git(self.source, "update-index", "--add", "--cacheinfo", "160000," + self.base + ",apps/form/nested")
        git(self.source, "commit", "--quiet", "-m", "gitlink", "--no-gpg-sign")
        self.env["SOURCE_SHA"] = git(self.source, "rev-parse", "HEAD")
        self.event["pull_request"]["head"]["sha"] = self.env["SOURCE_SHA"]
        self.merge()
        self.assertEqual(self.observe()["input_digest"], "")

    def test_dirty_tooling_and_wrong_executing_helper(self):
        (self.tooling / impact.HELPER).write_text("raise AssertionError('never import')")
        self.assertEqual(self.observe()["reason"], "checkout-not-clean")
        self.merge()
        result = impact.observe(self.source, self.tooling, self.env, self.event, __file__)
        self.assertEqual(result["reason"], "helper-location-mismatch")

    def test_clean_checkout_filters_cannot_hide_different_tooling_bytes(self):
        # Git can consider CRLF checkout bytes clean under text normalization.
        self.write(self.tooling, ".gitattributes", "apps/form/scripts/driver.py text eol=crlf\n")
        self.merge()
        self.assertEqual(git(self.tooling, "status", "--porcelain"), "")
        driver = self.tooling / "apps/form/scripts/driver.py"
        driver.write_bytes(driver.read_bytes().replace(b"\n", b"\r\n"))
        git(self.tooling, "add", "apps/form/scripts/driver.py")
        self.assertEqual(git(self.tooling, "status", "--porcelain"), "")
        self.assertEqual(self.observe()["reason"], "tooling-driver-mismatch")

    def test_missing_app_and_helper_cannot_emit_fingerprint(self):
        helper = self.tooling / impact.HELPER
        helper.unlink()
        self.merge()
        self.assertEqual(self.observe()["input_digest"], "")
        self.write(self.tooling, impact.HELPER, (ROOT / impact.HELPER).read_text())
        for path in (self.source / "apps/form").rglob("*"):
            if path.is_file():
                path.unlink()
        self.source_changed()
        self.assertEqual(self.observe()["input_digest"], "")

    def test_dynamic_guard_escapes_never_authorize_reuse(self):
        # These are deliberately *not* claimed safe by a regex JS/config parser.
        for path, text in (
                ("package.json", '{"workspaces":["apps/*"]}'),
                ("apps/form/package.json", '{"dependencies":{"x":"file:../../outside"}}'),
                ("apps/form/package-lock.json", '{"packages":{"node_modules/x":{"link":true}}}'),
                ("apps/form/app.config.js", 'module.exports = require("../../outside");'),
                ("apps/form/metro.config.js", 'module.exports = {watchFolders:["../../"]};'),
                ("apps/form/index.ts", 'import {x} from "../../services/api";'),
                ("apps/form/escaped.ts", r'import x from "\u002e\u002e/outside";'),
                ("apps/form/computed.ts", 'require(variable); import(variable);'),
                ("apps/form/install.js", 'eval("require")(outside);'),
                ("services/api/package.json", '{"dependencies":{"x":"workspace:*"}}'),
                ("unknown-native-path/build.sh", "touch /must-not-execute")):
            with self.subTest(path=path):
                self.write(self.source, path, text)
                self.source_changed()
                result = self.observe()
                self.assert_full(result)
                self.assertEqual(result["reason"], "dependency-closure-unverified")

    def test_outputs_are_bounded_and_do_not_include_source(self):
        self.env.update(GITHUB_OUTPUT=str(self.parent / "outputs"),
                        GITHUB_STEP_SUMMARY=str(self.parent / "summary"))
        with contextlib.redirect_stdout(io.StringIO()):
            impact.emit(self.observe(), self.env)
        outputs = Path(self.env["GITHUB_OUTPUT"]).read_text()
        self.assertRegex(outputs, r"\Ainput_digest=[0-9a-f]{64}\nrecord_digest=[0-9a-f]{64}\nmode=full\nidentity_status=unknown\nreuse=unknown\n\Z")
        summary = Path(self.env["GITHUB_STEP_SUMMARY"]).read_text()
        self.assertNotIn("do not execute", summary)
        self.assertLess(len(summary), 8192)
        self.event["pull_request"]["base"]["ref"] = "bad\n```\nINJECTED=1"
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            impact.emit(self.observe(), {})
        self.assertNotIn("INJECTED", captured.getvalue())

    def test_workflow_cli_reads_objects_and_emits_provenance(self):
        event = self.parent / "event.json"
        event.write_text(json.dumps(self.event))
        env = {**os.environ, **self.env, "GITHUB_EVENT_PATH": str(event),
               "GITHUB_OUTPUT": str(self.parent / "outputs"),
               "GITHUB_STEP_SUMMARY": str(self.parent / "summary")}
        process = subprocess.run([sys.executable, "-B", str(self.tooling / impact.HELPER),
                                  "--source", str(self.source), "--tooling", str(self.tooling)],
                                 env=env, text=True, capture_output=True, check=True, timeout=30)
        self.assertEqual(json.loads(process.stdout), self.observe())


class WorkflowTests(unittest.TestCase):
    def expression(self, key):
        return re.search(r"^\s*" + re.escape(key) + r": \$\{\{ (.+) \}\}$", WORKFLOW, re.M).group(1)

    def evaluate(self, expression, values):
        # The supported subset is deliberately closed; unknown syntax fails tests.
        token = r"success\(\)|[A-Za-z_][A-Za-z0-9_.]*|'[^']*'|==|!=|&&|\|\|"
        tokens = re.findall(token, expression)
        self.assertEqual("".join(tokens), re.sub(r"\s+", "", expression))
        mapped = []
        for item in tokens:
            if item in ("&&", "||"):
                mapped.append({"&&": "and", "||": "or"}[item])
            elif item in ("==", "!=") or item.startswith("'"):
                mapped.append(item)
            else:
                mapped.append(repr(values[item]))
        return eval(" ".join(mapped), {"__builtins__": {}}, {})

    def test_cancellation_truth_table(self):
        expression = self.expression("cancel-in-progress")
        for event in ("pull_request", "workflow_dispatch", "push", "schedule"):
            for action in ("synchronize", "opened", "edited", "reopened", "", "closed"):
                actual = self.evaluate(expression, {"github.event_name": event, "github.event.action": action})
                self.assertEqual(actual, event == "pull_request" and action == "synchronize")
        self.assertIn("group: lift-ios-${{ github.event_name }}-${{ inputs.source_sha || github.ref }}", WORKFLOW)

    def test_receipt_requires_successful_native_execution_and_prior_steps(self):
        receipt = WORKFLOW.split("      - name: native executed ", 1)[1]
        self.assertTrue(receipt.startswith("${{ steps.native_identity.outputs.input_digest }}\n"))
        expression = re.search(r"if: \$\{\{ (.+) \}\}", receipt).group(1)
        for success in (True, False):
            for outcome in ("success", "failure", "cancelled", "skipped", ""):
                for digest in ("a" * 64, ""):
                    actual = self.evaluate(expression, {"success()": success,
                        "steps.native_build.outcome": outcome,
                        "steps.native_identity.outputs.input_digest": digest})
                    self.assertEqual(actual, success and outcome == "success" and bool(digest))
        self.assertLess(WORKFLOW.index("id: native_build"), WORKFLOW.index("actions/upload-artifact@"))
        self.assertLess(WORKFLOW.index("actions/upload-artifact@"), WORKFLOW.index("- name: native executed"))
        self.assertNotIn("continue-on-error:", WORKFLOW)
        build = WORKFLOW.split("      - name: Build and launch exact source\n", 1)[1].split("      - name:", 1)[0]
        self.assertNotIn("if:", build)
        self.assertIn('python3 tooling/apps/form/scripts/ci-ios-simulator.py --source source --output evidence --scratch-parent "$GITHUB_WORKSPACE" --sha "$SOURCE_SHA"', build)
        self.assertIn("permissions:\n  contents: read\n", WORKFLOW)
        self.assertNotIn("actions: read", WORKFLOW)

    def test_identity_runs_after_both_checkouts_before_native_work(self):
        self.assertLess(WORKFLOW.index("path: source"), WORKFLOW.index("id: native_identity"))
        self.assertLess(WORKFLOW.index("scripts/native-impact.test.py"), WORKFLOW.index("scripts/native-impact.py --"))
        self.assertLess(WORKFLOW.index("scripts/native-impact.py --"), WORKFLOW.index("actions/setup-node@"))

    def test_receipt_shell_validates_digest_and_records_run_attempt(self):
        receipt = WORKFLOW.split("      - name: native executed ", 1)[1]
        script = receipt.split("        run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in script.splitlines())
        subprocess.run(["bash", "-n"], input=script, text=True, check=True)
        with tempfile.TemporaryDirectory(prefix="native-receipt-", dir=ROOT / "scripts") as folder:
            summary = Path(folder) / "summary"
            env = {**os.environ, "GITHUB_STEP_SUMMARY": str(summary),
                   "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}
            for digest in ("", "digest", "a" * 64 + "\nforged"):
                result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script],
                                        env={**env, "NATIVE_INPUT_DIGEST": digest})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(summary.exists())
            subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], check=True,
                           env={**env, "NATIVE_INPUT_DIGEST": "a" * 64})
            self.assertIn("native executed " + "a" * 64 + " (run 123, attempt 2)", summary.read_text())


def cancel(signum, frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    with FIXTURES:
        unittest.main()
