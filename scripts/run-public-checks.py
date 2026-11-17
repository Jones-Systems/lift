#!/usr/bin/env python3
"""Run the public snapshot contract; see PUBLIC-TESTING.md for its limits."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


API = "services/api"
APP = "apps/form"
HELPER = "scripts/run-public-checks.py"
HARNESS_TEST = "scripts/run-public-checks.test.py"
SOURCE_HOOK = "scripts/integration/source-hook.mjs"
SOURCE_RESOLVER = "scripts/integration/source-resolution.mjs"
GROUP_IDS = ("runner-contract", "api-compile", "app-static", "form104-139", "form196", "form203", "form208", "simulator-portable", "native-e2e-backend", "native-e2e-app", "lifecycle-runtime", "lifecycle-wire-v2", "plan-revision")
BASELINE_HEALTH = (
    "tests/wearables/app.test.mjs", "tests/wearables/ingestion.test.mjs",
    "tests/wearables/providers.test.mjs", "tests/wearables/suggestions.test.mjs",
    "tests/wearables/persistence/persistence.test.mjs", "tests/wearables/persistence/checkpoint.test.mjs",
    "tests/wearables/upload-intents/upload-intents.test.mjs",
    "tests/wearables/purge-intents/purge-intents.test.mjs",
    "tests/wearables/canonical-consumer/canonical-consumer.test.mjs",
    "tests/direct-provider-transport/transport.test.mjs",
    "tests/direct-provider-transport/concrete-auth.test.mjs",
    "tests/direct-provider-transport/auth-state.test.mjs",
)
APP_TESTS = {
    "lifecycle-wire-v2": ("src/account-lifecycle/__tests__/contracts-v2.test.cjs",
                          "src/account-lifecycle/__tests__/lifecycle.test.cjs"),
    "native-e2e-app": ("src/integration/tests/account-switch-session.test.cjs",
                       "src/integration/tests/settings-mode-http.test.cjs",
                       "src/integration/tests/manual-progress-session.test.cjs",
                       "src/integration/tests/runtime-lifecycle-composition.test.cjs"),
    "form196": ("src/features/feature-board/tests/controller.test.cjs",),
    "form203": ("src/api/tests/community-group-role-controller.test.cjs", "src/community/matching/__tests__/controller.test.cjs"),
    "form208": ("src/voice-coaching/standard/tests/wire-codec.test.cjs",),
}
API_TESTS = {
    "plan-revision": ("tests/planning/plan-revision-port.test.ts", "tests/backend.test.ts"),
    "lifecycle-wire-v2": ("tests/lifecycle-wire-v2.test.ts",),
    "lifecycle-runtime": (
        "tests/bug-intake/lifecycle-chain.test.ts",
        "tests/integration/account-modules/canonical-writer.test.ts",
        "tests/integration/account-modules/composition.test.ts",
        "tests/integration/account-modules/server.test.ts",
        "tests/integration/request-factories.test.ts",
        "tests/lifecycle-completion.test.ts",
        "tests/lifecycle-coverage.test.ts",
        "tests/lifecycle-evidence-codec.test.ts",
        "tests/lifecycle-evidence.test.ts",
        "tests/lifecycle-export.test.ts",
        "tests/lifecycle-http.test.ts",
        "tests/lifecycle-provider-revocation-apple.test.ts",
        "tests/lifecycle-provider-revocation.test.ts",
        "tests/lifecycle-purge-executor.test.ts",
        "tests/lifecycle-reauthentication-source.test.ts",
        "tests/lifecycle-reauthentication.test.ts",
        "tests/lifecycle.test.ts",
        "tests/purchases/purchases.test.ts",
        "tests/purchases/reconciliation.test.ts",
        "tests/purchases/status-codec.test.ts",
        "tests/purchases/status-projection.test.ts",
        "tests/purchases/status-source.test.ts",
        "tests/purchases/status.test.ts",
        "tests/runtime-modules/authority-currentness.test.ts",
        "tests/runtime-modules/capability-and-denial.test.ts",
        "tests/runtime-modules/closed-read-admission.test.ts",
        "tests/runtime-modules/closed-read-storage.test.ts",
        "tests/runtime-modules/composition-http.test.ts",
        "tests/runtime-modules/configuration-and-lifetime.test.ts",
        "tests/runtime-modules/export-http.test.ts",
        "tests/runtime-modules/late-boundary-regression.test.ts",
        "tests/runtime-modules/migrations-and-restart.test.ts",
        "tests/runtime-modules/relocated-admission.test.ts",
        "tests/runtime-modules/restore-admission.test.ts",
        "tests/runtime-modules/restore-drill.test.ts",
        "tests/usage-limits/lifecycle.test.ts",
    ),
    "native-e2e-backend": ("tests/e2e/native-backend.test.ts",),
    "form196": ("tests/community/board/correction.test.ts", "tests/community/board/board.test.ts", "tests/community/board/persistence-races.test.ts"),
    "form208": ("tests/voice-coaching/standard-wire.test.ts", "tests/voice-coaching/turn-controller.test.ts",
                "tests/usage-limits/standard-observation.test.ts", "tests/usage-limits/standard-composition.test.ts",
                "tests/usage-limits/live-composition.test.ts"),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selection(root, requested):
    chosen = set(requested or GROUP_IDS)
    if chosen - set(GROUP_IDS):
        raise ValueError("Unknown public check group")
    # Interop, native E2E smoke tests and board workers load fresh emitted API JavaScript.
    if chosen & {"form196", "form208", "native-e2e-backend", "native-e2e-app", "lifecycle-runtime", "lifecycle-wire-v2", "plan-revision"}:
        chosen.add("api-compile")
    groups = [group for group in GROUP_IDS if group in chosen]
    health = sorted(str(path.relative_to(root / API)) for directory in
                    ("tests/wearables", "tests/direct-provider-transport")
                    for path in (root / API / directory).rglob("*.test.mjs"))
    commands = []

    def add(group, cwd, argv, sources=()):
        for source in sources:
            if not (root / cwd / source).is_file():
                raise FileNotFoundError(f"Required {group} input is missing: {cwd}/{source}")
        commands.append({"group": group, "cwd": cwd, "argv": list(argv),
                         "test_sources": [f"{cwd}/{source}" if cwd != "." else source for source in sources]})

    for group in groups:
        if group == "runner-contract":
            add(group, ".", [sys.executable, "-B", HARNESS_TEST], [HELPER, HARNESS_TEST])
        elif group == "api-compile":
            add(group, API, ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], ["tsconfig.json"])
        elif group == "app-static":
            add(group, APP, ["npm", "run", "typecheck"])
            add(group, APP, ["npm", "run", "check:tokens"])
        elif group == "form104-139":
            for source in BASELINE_HEALTH:
                if source not in health:
                    raise FileNotFoundError(f"Required {group} baseline is missing: {API}/{source}")
            add(group, API, ["node", "--experimental-transform-types", "--import", f"./{SOURCE_HOOK}",
                            "--test", "--test-isolation=none", "--test-concurrency=1", *health],
                [SOURCE_HOOK, SOURCE_RESOLVER, *health])
        elif group == "simulator-portable":
            test = "scripts/ci-ios-simulator.test.py"
            add(group, APP, [sys.executable, "-B", test], [test, "scripts/ci-ios-simulator.py"])
            test = "scripts/ios_e2e.test.py"
            add(group, APP, [sys.executable, "-B", test], [test, "scripts/ios_e2e.py"])
        else:
            if group in API_TESTS:
                sources = API_TESTS[group]
                emitted = ["dist/" + source.removesuffix(".ts") + ".js" for source in sources]
                if group == "lifecycle-runtime":
                    sources = (*sources, "tests/runtime-modules/restore-drill-fixture.ts",
                               "tests/lifecycle-reauthentication-fixture.ts",
                               "tests/purchases/status-source-fixture.ts")
                if group == "native-e2e-backend":
                    sources = (*sources, "tests/e2e/native-backend.ts", SOURCE_HOOK, SOURCE_RESOLVER)
                add(group, API, ["node", "--test", "--test-concurrency=1", *emitted], sources)
            if group in APP_TESTS:
                sources = APP_TESTS[group]
                add(group, APP, ["node", "--test", "--test-concurrency=1", *sources], sources)
            if group == "native-e2e-app":
                renderer = "tests/renderer/onboarding-save.test.tsx"
                add(group, APP, ["npm", "run", "test:renderer", "--", "--runTestsByPath", renderer],
                    [renderer, "jest.config.cjs", "tests/renderer/setup.ts", "tests/renderer/resolver.cjs"])
    payload = {"schema": "lift.public-check-groups/v1", "groups": groups, "commands": commands}
    payload["manifest_sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return payload


def copy_inputs(root, destination, install):
    excluded = shutil.ignore_patterns("node_modules", "dist", ".scratch", "__pycache__", ".expo", ".git")
    for directory in ("apps", "services", "packages"):
        shutil.copytree(root / directory, destination / directory, ignore=excluded)
    (destination / "scripts").mkdir()
    for name in (HELPER, HARNESS_TEST):
        shutil.copy2(root / name, destination / name)
    if not install:
        for directory in (API, APP):
            dependencies = root / directory / "node_modules"
            if dependencies.is_dir():
                (destination / directory / "node_modules").symlink_to(dependencies, target_is_directory=True)


@contextmanager
def owned_workspace(root, install):
    parent = Path.home()
    if not parent.is_absolute() or parent.resolve(strict=True) != parent or parent.is_relative_to(root.resolve()):
        raise ValueError("Unsafe public workspace parent: HOME must be canonical and outside the source checkout")
    for ancestor in (parent, *parent.parents):
        metadata = ancestor.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o022:
            raise ValueError("Unsafe public workspace parent: directory ancestors must not be symlinks or group/other writable")
        if ancestor == parent and metadata.st_uid != os.getuid():
            raise ValueError("Unsafe public workspace parent: HOME must belong to the current user")
    with tempfile.TemporaryDirectory(prefix=".lift-public-", dir=parent) as temporary:
        workspace = Path(temporary)
        copy_inputs(root, workspace, install)
        yield workspace


@contextmanager
def cancellation_handlers():
    def interrupted(signum, _frame):
        raise InterruptedError(signum, "Public checks cancelled")

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def run_command(command, workspace, environment, log):
    started = time.monotonic()
    child = None
    with log.open("w") as output:
        try:
            child = subprocess.Popen(command["argv"], cwd=workspace / command["cwd"], env=environment,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     start_new_session=True)
            for line in child.stdout:
                output.write(line)
                print(line, end="", flush=True)
            code = child.wait()
            return {"returncode": code, "seconds": round(time.monotonic() - started, 3)}
        finally:
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                if child.poll() is None:
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                child.stdout.close()


def execute(root, output, contract, install=False):
    output.mkdir(parents=True, exist_ok=False)
    receipt = {**contract, "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
               "helper_sha256": digest(root / HELPER), "input_sha256": {}, "results": [], "status": "running"}
    for command in contract["commands"]:
        for source in command["test_sources"]:
            receipt["input_sha256"][source] = digest(root / source)
    primary_status = 0
    try:
        with cancellation_handlers(), owned_workspace(root, install) as workspace:
            receipt["scratch_root"] = str(workspace)
            home = workspace / "home"
            home.mkdir(mode=0o700)
            environment = {**os.environ, "HOME": str(home), "TMPDIR": str(workspace), "TMP": str(workspace), "TEMP": str(workspace),
                           "PYTHONDONTWRITEBYTECODE": "1", "CI": "1", "EXPO_NO_TELEMETRY": "1",
                           "EXPO_NO_DOTENV": "1", "EXPO_PUBLIC_FORM_API_URL": "http://127.0.0.1:9",
                           "npm_config_cache": str(workspace / "npm-cache")}
            commands = ([{"group": "install", "cwd": directory, "argv": ["npm", "ci"], "test_sources": []}
                         for directory in (API, APP)] if install else []) + contract["commands"]
            for index, command in enumerate(commands):
                print(f"\n[{command['group']}] {command['cwd']}: {json.dumps(command['argv'])}", flush=True)
                result = {**command, "log": f"{index:02d}-{command['group']}.log", "status": "running"}
                receipt["results"].append(result)
                result.update(run_command(command, workspace, environment, output / result["log"]))
                result["status"] = "passed" if result["returncode"] == 0 else "failed"
                if result["returncode"]:
                    receipt["status"] = "failed"
                    primary_status = result["returncode"] if result["returncode"] > 0 else 128 - result["returncode"]
                    return primary_status
            receipt["status"] = "passed"
            return 0
    except InterruptedError as error:
        receipt["status"] = "cancelled"
        receipt["error"] = str(error)
        return 128 + error.errno
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = str(error)
        return primary_status or 1
    finally:
        receipt["scratch_removed"] = not Path(receipt.get("scratch_root", root)).exists()
        for result in receipt["results"]:
            if result["status"] == "running":
                result["status"] = "interrupted" if receipt["status"] == "cancelled" else "failed"
        completed = len([result for result in receipt["results"] if result["group"] != "install"])
        receipt["not_run"] = contract["commands"][completed:]
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", action="append", choices=GROUP_IDS)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--install", action="store_true", help="Install locked dependencies inside the owned workspace")
    parser.add_argument("--output", type=Path, default=Path("public-check-evidence"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    contract = selection(root, args.group)
    if args.list:
        print(json.dumps(contract, indent=2))
        return 0
    output = args.output.resolve()
    if output == root or output.is_relative_to(root / "apps") or output.is_relative_to(root / "services") or output.is_relative_to(root / "packages"):
        parser.error("Evidence must be outside the copied source roots")
    return execute(root, output, contract, args.install)


if __name__ == "__main__":
    sys.exit(main())
