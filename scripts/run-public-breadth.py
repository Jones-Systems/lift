#!/usr/bin/env python3
"""Run the public-eligible breadth groups; limits and ownership: TEST-PLACEMENT.md."""

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "scripts/public-test-placement.json"
HELPER = "scripts/run-public-breadth.py"
CONTRACT_TEST = "scripts/run-public-breadth.test.py"
API, APP, WEBSITE, ADAPTER = "services/api", "apps/form", "apps/form-website", "packages/chatgpt-adapter"
GROUP_IDS = ("breadth-contract", "api-breadth", "app-breadth", "app-renderer", "website", "adapter-unit")
EXCLUDED_DIRS = {"node_modules", "dist", ".scratch", ".expo", ".git", "__pycache__"}
ADDITIONAL_PEAK_BYTES = 6 * 1024 ** 3
RESERVE_BYTES = 2 * 1024 ** 3
APPLE_SKIP = "real Apple-signed Sandbox positive-proof gate"
APPLE_REASON = "No licensed, provisioned Form Sandbox signed JWS is supplied. Synthetic claims do not prove successful cryptographic verification or native activation."


def load_public(root):
    spec = importlib.util.spec_from_file_location("public_checks", root / "scripts/run-public-checks.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def conventional(path):
    return bool(re.search(r"\.test\.(?:cjs|mjs|ts|tsx|py)$", path) or
                (Path(path).name.startswith("test_") and path.endswith(".py")))


def discover(root):
    found = []
    for directory in ("apps", "services", "packages", "scripts"):
        for parent, directories, files in os.walk(root / directory):
            directories[:] = sorted(d for d in directories if d not in EXCLUDED_DIRS and not d.startswith("."))
            for name in files:
                path = Path(parent) / name
                if conventional(name):
                    if path.is_symlink():
                        raise ValueError(f"Test discovery refuses symlinks: {path}")
                    found.append(path.relative_to(root).as_posix())
    return sorted(found)


def partition(root, manifest, discovered, hosted):
    if manifest.get("schema") != "lift.public-test-placement/v1":
        raise ValueError("Unknown placement schema")
    seen = set()
    for group in manifest["groups"]:
        if group["placement"] not in {"existing-hosted", "breadth", "blocked"} or not group.get("reason"):
            raise ValueError("Every group needs a placement and reason")
        if group["placement"] == "blocked" and (not group.get("missing_inputs") or not group.get("route")):
            raise ValueError("Blocked groups need exact missing inputs and a qualification route")
        for source in group["files"]:
            if source.startswith("/") or ".." in source.split("/") or "\\" in source or not conventional(source):
                raise ValueError(f"Invalid source: {source}")
            if source in seen:
                raise ValueError(f"Overlapping placement: {source}")
            seen.add(source)
    actual = set(discovered)
    if seen != actual:
        raise ValueError(f"Placement drift: unknown={sorted(actual - seen)}, stale={sorted(seen - actual)}")
    expected_hosted = {source for group in manifest["groups"] if group["placement"] == "existing-hosted" for source in group["files"]}
    if expected_hosted != set(hosted):
        raise ValueError("Existing hosted selection changed; reconcile placement manifest")
    breadth = [group for group in manifest["groups"] if group["placement"] == "breadth"]
    if sorted(group["id"] for group in breadth) != sorted(GROUP_IDS):
        raise ValueError("Breadth group contract drift")
    return breadth


def selection(root):
    public = load_public(root)
    hosted = {source for command in public.selection(root, None)["commands"]
              for source in command["test_sources"] if conventional(source)}
    hosted.update({"scripts/native-impact.test.py", "scripts/ci-placement.test.py"})
    manifest = json.loads((root / MANIFEST).read_text())
    discovered = discover(root)
    breadth = partition(root, manifest, discovered, hosted)
    groups = {group["id"]: group for group in breadth}
    commands = []

    def add(group, cwd, argv, sources=(), reporter=None):
        commands.append({"group": group, "cwd": cwd, "argv": argv,
                         "test_sources": list(sources), "reporter": reporter})

    add("breadth-contract", ".", [sys.executable, "-B", CONTRACT_TEST], [CONTRACT_TEST], "unittest")
    add("api-compile", API, ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"])
    api = groups["api-breadth"]["files"]
    modules = [p.removeprefix(API + "/") for p in api]
    emitted = ["dist/" + p[:-3] + ".js" if p.endswith(".ts") else p for p in modules]
    add("api-breadth", API, ["node", "--experimental-transform-types", "--import",
                            "./scripts/integration/source-hook.mjs", "--test", "--test-reporter=tap",
                            "--test-concurrency=1", *emitted], api, "tap")
    add("app-transport-compile", APP, ["node", "node_modules/typescript/bin/tsc", "src/api/transport.ts",
                                     "--target", "ES2022", "--module", "commonjs", "--strict", "--skipLibCheck",
                                     "--lib", "ES2022,DOM", "--outDir", ".scratch/api-tests"])
    app = groups["app-breadth"]["files"]
    if f"{APP}/src/api/tests/phone-signin.test.cjs" not in app:
        raise ValueError("App breadth must retain the embedded standalone transport suite")
    add("app-breadth", APP, ["node", "--test", "--test-reporter=tap", "--test-concurrency=1",
                            *[p.removeprefix(APP + "/") for p in app]], app, "tap")
    renderer = groups["app-renderer"]["files"]
    add("app-renderer", APP, ["npm", "run", "test:renderer", "--", "--json", "--outputFile=renderer-results.json",
                             "--runTestsByPath", *[p.removeprefix(APP + "/") for p in renderer]], renderer, "jest")
    voice = root / APP / "src/voice-coaching/session-controller.ts"
    if not voice.is_file():
        raise FileNotFoundError("Website voice qualification requires apps/form/src/voice-coaching/session-controller.ts")
    website = groups["website"]["files"]
    add("website", WEBSITE, ["node", "--experimental-transform-types", "--test", "--test-reporter=tap",
                             "--test-concurrency=1", *[p.removeprefix(WEBSITE + "/") for p in website]], website, "tap")
    adapter = groups["adapter-unit"]["files"]
    package = json.loads((root / ADAPTER / "package.json").read_text())
    expected = "node --test --test-concurrency=1 " + " ".join(p.removeprefix(ADAPTER + "/") for p in adapter)
    if package["scripts"]["test"] != expected:
        raise ValueError("Adapter npm test selection drift")
    add("adapter-unit", ADAPTER, ["node", "--test", "--test-reporter=tap", "--test-concurrency=1",
                                 *[p.removeprefix(ADAPTER + "/") for p in adapter]], adapter, "tap")
    payload = {"schema": "lift.public-breadth/v1", "groups": list(GROUP_IDS), "commands": commands,
               "discovered_test_files": discovered, "existing_hosted_test_files": sorted(hosted),
               "blocked_groups": [g for g in manifest["groups"] if g["placement"] == "blocked"],
               "all_coverage_available": False, "placement_sha256": public.digest(root / MANIFEST)}
    payload["manifest_sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return payload


def counts(command, log, workspace):
    text = log.read_text()
    if command["reporter"] == "jest":
        data = json.loads((workspace / command["cwd"] / "renderer-results.json").read_text())
        return {"passed": data["numPassedTests"], "failed": data["numFailedTests"],
                "skipped": data["numPendingTests"], "todo": data["numTodoTests"]}
    if command["reporter"] == "unittest":
        result = re.search(r"^Ran (\d+) tests? in .+\n\nOK\s*$", text, re.M)
        if not result:
            raise ValueError("Missing successful unittest summary")
        return {"passed": int(result[1]), "failed": 0, "skipped": 0, "todo": 0}
    result = {}
    for key, label in (("passed", "pass"), ("failed", "fail"), ("skipped", "skipped"), ("todo", "todo")):
        matches = re.findall(rf"^# {label} (\d+)$", text, re.M)
        if not matches:
            raise ValueError(f"Missing TAP {label} summary")
        result[key] = int(matches[-1])
    if result["skipped"]:
        skip_lines = re.findall(r"^ok .+ # SKIP(?: .*)?$", text, re.M)
        expected = f"{APPLE_SKIP} # SKIP {APPLE_REASON}"
        allowed = command["group"] == "api-breadth" and result["skipped"] == 1 and len(skip_lines) == 1 and skip_lines[0].endswith(expected)
        result["documented_unavailable"] = 1 if allowed else 0
    return result


@contextmanager
def owned_workspace(root, install):
    public = load_public(root)
    with tempfile.TemporaryDirectory(prefix=".lift-breadth-", dir=root) as temporary:
        workspace = Path(temporary)
        public.copy_inputs(root, workspace, install)
        for name in (HELPER, CONTRACT_TEST, MANIFEST, "scripts/native-impact.test.py", "scripts/ci-placement.test.py"):
            shutil.copy2(root / name, workspace / name)
        workflow = ".github/workflows/public-breadth.yml"
        (workspace / ".github/workflows").mkdir(parents=True)
        shutil.copy2(root / workflow, workspace / workflow)
        if not install and (root / ADAPTER / "node_modules").is_dir():
            (workspace / ADAPTER / "node_modules").symlink_to(root / ADAPTER / "node_modules", target_is_directory=True)
        yield workspace


def run_command(command, workspace, environment, log):
    started = time.monotonic()
    child = None
    with log.open("w") as output:
        try:
            child = subprocess.Popen(command["argv"], cwd=workspace / command["cwd"], env=environment,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
            for line in child.stdout:
                output.write(line)
                print(line, end="", flush=True)
            return {"returncode": child.wait(), "seconds": round(time.monotonic() - started, 3)}
        finally:
            if child:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                finally:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait()
                    child.stdout.close()


def admit_storage(root):
    free = shutil.disk_usage(root).free
    if free < RESERVE_BYTES + ADDITIONAL_PEAK_BYTES:
        raise OSError(f"Storage admission refused: {root}: free={free}, reserve={RESERVE_BYTES}, additional_peak={ADDITIONAL_PEAK_BYTES}")
    return {"destination": str(root), "available_bytes": free, "reserve_bytes": RESERVE_BYTES,
            "estimated_additional_peak_bytes": ADDITIONAL_PEAK_BYTES}


def execute(root, output, contract, install=False):
    public = load_public(root)
    output.mkdir(parents=True, exist_ok=False)
    receipt = {**contract, "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
               "helper_sha256": public.digest(root / HELPER), "results": [], "status": "running",
               "executed_test_files": [], "case_counts_complete": True,
               "case_counts": {"passed": 0, "failed": 0, "skipped": 0, "todo": 0},
               "input_sha256": {source: public.digest(root / source) for source in contract.get("discovered_test_files", [])}}
    status = 0
    try:
        receipt["storage_admission"] = admit_storage(root)
        with public.cancellation_handlers(), owned_workspace(root, install) as workspace:
            receipt["scratch_root"] = str(workspace)
            environment = {**os.environ, "TMPDIR": str(workspace), "TMP": str(workspace), "TEMP": str(workspace),
                           "PYTHONDONTWRITEBYTECODE": "1", "CI": "1", "EXPO_NO_TELEMETRY": "1", "EXPO_NO_DOTENV": "1",
                           "EXPO_PUBLIC_FORM_API_URL": "http://127.0.0.1:9", "npm_config_cache": str(workspace / "npm-cache"),
                           "FORM_BROWSER_VOICE_SESSION_MODULE": str(workspace / APP / "src/voice-coaching/session-controller.ts")}
            environment.pop("NODE_TEST_CONTEXT", None)
            commands = ([{"group": "install", "cwd": directory, "argv": ["npm", "ci"], "test_sources": [], "reporter": None}
                         for directory in (API, APP, ADAPTER)] if install else []) + contract["commands"]
            for index, command in enumerate(commands):
                admit_storage(root)
                result = {**command, "log": f"{index:02d}-{command['group']}.log", "status": "running"}
                receipt["results"].append(result)
                result.update(run_command(command, workspace, environment, output / result["log"]))
                status = result["returncode"] if result["returncode"] >= 0 else 128 - result["returncode"]
                if command["reporter"]:
                    try:
                        result["case_counts"] = counts(command, output / result["log"], workspace)
                        for key in receipt["case_counts"]:
                            receipt["case_counts"][key] += result["case_counts"][key]
                        observed = result["case_counts"]
                        if observed["failed"] or observed["todo"] or observed["skipped"] > observed.get("documented_unavailable", 0) or not observed["passed"]:
                            result["qualification_error"] = "Failures, unexpected skips/todos, or zero passing cases"
                            status = status or 1
                        if not result["returncode"]:
                            receipt["executed_test_files"].extend(command["test_sources"])
                    except (ValueError, KeyError, OSError) as error:
                        result["qualification_error"] = str(error)
                        result["case_counts"] = None
                        receipt["case_counts_complete"] = False
                        status = status or 1
                if command["reporter"] == "jest":
                    report = workspace / command["cwd"] / "renderer-results.json"
                    if report.is_file():
                        shutil.copy2(report, output / "renderer-results.json")
                result["status"] = "failed" if status else "passed"
                if status:
                    break
            receipt["status"] = "failed" if status else "passed-public-eligible"
    except InterruptedError as error:
        status = 128 + error.errno
        receipt.update(status="cancelled", error=str(error))
    except Exception as error:
        status = status or 1
        receipt.update(status="failed", error=str(error))
    finally:
        receipt["scratch_removed"] = "scratch_root" not in receipt or not Path(receipt["scratch_root"]).exists()
        completed = {source for result in receipt["results"] for source in result["test_sources"]}
        receipt["not_run_test_files"] = [source for command in contract["commands"] for source in command["test_sources"] if source not in completed]
        receipt["unconfirmed_test_files"] = sorted(completed - set(receipt["executed_test_files"]))
        if receipt["not_run_test_files"] or receipt["unconfirmed_test_files"]:
            receipt["case_counts_complete"] = False
        for result in receipt["results"]:
            if result["status"] == "running":
                result["status"] = "interrupted" if receipt["status"] == "cancelled" else "failed"
        receipt["exit_status"] = status
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--require-all-coverage", action="store_true", help="Fail while any private or real-provider qualification remains unavailable")
    parser.add_argument("--output", type=Path, default=Path("public-breadth-evidence"))
    args = parser.parse_args()
    contract = selection(ROOT)
    if args.list:
        print(json.dumps(contract, indent=2))
        return 1 if args.require_all_coverage and not contract["all_coverage_available"] else 0
    if args.require_all_coverage and not contract["all_coverage_available"]:
        parser.error("All coverage is unavailable; see blocked groups and the real Apple proof gate in TEST-PLACEMENT.md")
    output = args.output.resolve()
    if output.parent != ROOT:
        parser.error("Evidence must be a new direct child of the repository, outside disposable scratch")
    return execute(ROOT, output, contract, args.install)


if __name__ == "__main__":
    sys.exit(main())
