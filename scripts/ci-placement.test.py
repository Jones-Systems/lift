"""CI-placement contract: opt-in, trust and cancellation without native builds."""

import fnmatch
import json
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
E2E = (ROOT / ".github/workflows/lift-ios-e2e.yml").read_text()
PUBLIC = (ROOT / ".github/workflows/public-checks.yml").read_text()
SIMULATOR = (ROOT / ".github/workflows/form-ios-simulator.yml").read_text()


class PlacementTests(unittest.TestCase):
    def test_trigger_and_source_contract(self):
        events = E2E.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("  workflow_dispatch:\n", events)
        self.assertRegex(events, r"  schedule:\n    - cron: '[^']+'")
        self.assertIn("types: [opened, synchronize, reopened, labeled]", events)
        self.assertNotIn("edited", events)
        self.assertEqual(re.findall(r"      - '([^']+)'", events), [
            "apps/form/**", "services/api/**", "packages/**",
            ".github/workflows/lift-ios-e2e.yml", "scripts/ci-placement.test.py",
        ])
        self.assertIn("  cancel-in-progress: true\n", E2E)
        self.assertIn("SOURCE_SHA: ${{ inputs.source_sha || github.event.pull_request.head.sha || github.sha }}", E2E)
        self.assertEqual(E2E.count("ref: ${{ env.SOURCE_SHA }}"), 2)
        self.assertEqual(E2E.count("persist-credentials: false"), 2)
        self.assertIn("permissions:\n  contents: read\n", E2E)
        self.assertIn("lift-pair/v1 head=${{ github.event.pull_request.head.sha || inputs.source_sha || github.sha }}", E2E)
        self.assertIn("name: Public app, API and portable checks", PUBLIC)
        self.assertIn("run: python3 -B scripts/ci-placement.test.py", PUBLIC)
        # Keep the paired-PR refresh event, but avoid native builds for prose-only
        # and independent breadth-runner changes. A product or driver edit runs.
        simulator_events = SIMULATOR.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("types: [opened, synchronize, reopened, edited]", simulator_events)
        patterns = re.findall(r"      - '([^']+)'", simulator_events)
        for source in ("apps/form/src/app.tsx", "services/api/src/server.ts", "packages/example/index.ts",
                       ".gitattributes", ".github/workflows/form-ios-simulator.yml",
                       "scripts/native-impact.py", "scripts/native-impact.test.py", "scripts/ci-placement.test.py"):
            self.assertTrue(any(fnmatch.fnmatchcase(source, pattern) for pattern in patterns), source)
        for source in ("README.md", "BUILD.md", "AGENTS.md", "TEST-PLACEMENT.md",
                       "scripts/run-public-breadth.py", ".github/workflows/public-breadth.yml"):
            self.assertFalse(any(fnmatch.fnmatchcase(source, pattern) for pattern in patterns), source)

    def test_qualifying_runs_share_group_and_ignored_events_cannot_cancel_them(self):
        guard = re.search(r"^    if: (.+)$", E2E, re.MULTILINE).group(1)
        group = re.search(r"^  group: lift-ios-e2e-\$\{\{ (.+) \}\}$", E2E, re.MULTILINE).group(1)
        cases = []
        for event, action, labels, added, trusted, allowed in [
            ("pull_request", "opened", [], "", True, False),
            ("pull_request", "synchronize", [], "", True, False),
            ("pull_request", "opened", ["native-e2e"], "", True, True),
            ("pull_request", "reopened", ["native-e2e"], "", True, True),
            ("pull_request", "synchronize", ["native-e2e"], "", True, True),
            ("pull_request", "labeled", ["native-e2e"], "native-e2e", True, True),
            ("pull_request", "labeled", ["native-e2e", "docs"], "docs", True, False),
            ("pull_request", "labeled", ["docs"], "docs", True, False),
            ("pull_request", "synchronize", ["native-e2e"], "", False, False),
            ("pull_request", "labeled", ["native-e2e"], "native-e2e", False, False),
            ("schedule", "", [], "", True, True),
            ("workflow_dispatch", "", [], "", True, True),
        ]:
            for run_id in ("9001", "9002"):
                pr = {"number": 42, "head": {"repo": {"full_name": "owner/lift" if trusted else "fork/lift"}},
                      "labels": [{"name": label} for label in labels]}
                github = {"event_name": event, "repository": "owner/lift", "ref": "refs/heads/build/lift",
                          "run_id": run_id, "event": {"action": action, "label": {"name": added},
                                                    "pull_request": pr if event == "pull_request" else {}}}
                expected_group = (42 if event == "pull_request" else github["ref"]) if allowed else f"ignored-{run_id}"
                cases.append({"github": github, "allowed": allowed, "group": expected_group})
        # For these fixture values, JS models the operators; translate the Actions array projection.
        script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const {guard, group, cases} = JSON.parse(fs.readFileSync(0, 'utf8'));
const project = expression => expression.replaceAll(
  'github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(label => label.name)');
const results = cases.map(({github}) => {
  const context = {github, contains: (values, item) => values.includes(item),
    format: (template, value) => template.replace('{0}', String(value))};
  return [vm.runInNewContext(project(guard), context), vm.runInNewContext(project(group), context)];
});
process.stdout.write(JSON.stringify(results));
"""
        result = subprocess.run(["node", "-e", script], input=json.dumps({"guard": guard, "group": group, "cases": cases}),
                                text=True, capture_output=True, check=True, timeout=10)
        for case, actual in zip(cases, json.loads(result.stdout), strict=True):
            with self.subTest(event=case["github"]):
                self.assertEqual(actual, [case["allowed"], case["group"]])


if __name__ == "__main__":
    unittest.main()
