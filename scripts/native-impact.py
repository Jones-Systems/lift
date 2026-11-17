"""Observe native inputs without executing product code or authorizing reuse."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess


SCHEMA = "lift-native-inputs/v1"
DOMAIN = b"lift-native-inputs/v1\0launch\0"
RECORD_DOMAIN = b"lift-native-record/v1\0launch\0"
WORKFLOW = ".github/workflows/form-ios-simulator.yml"
HELPER = "scripts/native-impact.py"
TEST = "scripts/native-impact.test.py"
SHA = re.compile(r"[0-9a-f]{40}")


class Unknown(ValueError):
    """A bounded reason code, never raw Git output or source content."""


def git(repo, *args):
    try:
        return subprocess.run(
            ["git", "--no-replace-objects", "-c", "core.fsmonitor=false",
             "-C", str(repo), *args], check=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=15,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"}).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise Unknown("git-object-unavailable") from exc


def commit(repo, expected):
    if not SHA.fullmatch(expected):
        raise Unknown("invalid-commit")
    actual = git(repo, "rev-parse", "--verify", "HEAD").decode().strip()
    if actual != expected or git(repo, "cat-file", "-t", expected) != b"commit\n":
        raise Unknown("checkout-commit-mismatch")
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise Unknown("checkout-not-clean")


def entry(repo, revision, path, kind, optional=False):
    raw = git(repo, "ls-tree", "-z", revision, "--", path)
    if not raw and optional:
        return {"path": path, "state": "absent"}
    try:
        meta, name = raw.rstrip(b"\0").split(b"\t")
        mode, actual_kind, oid = meta.decode("ascii").split()
        if name.decode("utf-8") != path or actual_kind != kind:
            raise ValueError
        if mode != ("040000" if kind == "tree" else "100644"):
            raise ValueError
        if not SHA.fullmatch(oid):
            raise ValueError
    except (ValueError, UnicodeError) as exc:
        raise Unknown("missing-or-unsupported-input") from exc
    if kind == "tree":
        # Including tree nodes catches symlinks/gitlinks before any filesystem read.
        for item in git(repo, "ls-tree", "-rzt", oid).split(b"\0"):
            if not item:
                continue
            metadata = item.split(b"\t", 1)[0].split()
            if len(metadata) != 3 or metadata[:2] not in (
                    [b"040000", b"tree"], [b"100644", b"blob"],
                    [b"100755", b"blob"]):
                raise Unknown("unsupported-tree-entry")
    return {"path": path, "mode": mode, "type": kind, "oid": oid}


def checked_out_blob(repo, revision, path, executing=None):
    result = entry(repo, revision, path, "blob")
    disk = Path(repo) / path
    try:
        if any(part.is_symlink() for part in (disk, *disk.parents)):
            raise Unknown("tooling-symlink")
        mode = disk.stat().st_mode
        if not stat.S_ISREG(mode) or mode & 0o111:
            raise Unknown("tooling-mode-mismatch")
        data = git(repo, "cat-file", "blob", result["oid"])
        if disk.read_bytes() != data:
            raise Unknown("tooling-bytes-mismatch")
        if executing is not None and Path(executing).resolve() != disk.resolve():
            raise Unknown("helper-location-mismatch")
    except OSError as exc:
        raise Unknown("tooling-file-unavailable") from exc
    return result


def provenance(source, tooling, env, event):
    if not isinstance(event, dict):
        raise Unknown("invalid-provenance")
    source_sha = env.get("SOURCE_SHA", "")
    tooling_sha = env.get("GITHUB_SHA", "")
    commit(source, source_sha)
    commit(tooling, tooling_sha)
    if env.get("GITHUB_REPOSITORY") != "Jones-Systems/lift":
        raise Unknown("repository-mismatch")
    workflow_sha = env.get("GITHUB_WORKFLOW_SHA", "")
    ref = env.get("GITHUB_REF", "")
    if (workflow_sha != tooling_sha or env.get("GITHUB_WORKFLOW_REF") !=
            "Jones-Systems/lift/" + WORKFLOW + "@" + ref):
        raise Unknown("workflow-ref-mismatch")
    event_name = env.get("GITHUB_EVENT_NAME", "")
    base_sha = "none"
    base_ref = "none"
    action = "none"
    if event_name == "pull_request":
        pr = event["pull_request"]
        number = event["number"]
        action = event["action"]
        base_sha, base_ref = pr["base"]["sha"], pr["base"]["ref"]
        if (type(number) is not int or number <= 0 or
                ref != f"refs/pull/{number}/merge" or
                action not in ("opened", "synchronize", "reopened", "edited") or
                pr["head"]["sha"] != source_sha or
                pr["head"]["repo"]["full_name"] != "Jones-Systems/lift" or
                pr["base"]["repo"]["full_name"] != "Jones-Systems/lift" or
                not SHA.fullmatch(base_sha) or not isinstance(base_ref, str) or
                not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", base_ref)):
            raise Unknown("pull-request-ref-mismatch")
        headers = git(tooling, "cat-file", "commit", tooling_sha).split(b"\n\n", 1)[0]
        parents = [line[7:].decode("ascii") for line in headers.splitlines()
                   if line.startswith(b"parent ")]
        if parents != [base_sha, source_sha]:
            raise Unknown("merge-parent-mismatch")
    elif event_name == "workflow_dispatch":
        inputs = event.get("inputs", {})
        if not isinstance(inputs, dict):
            raise Unknown("invalid-provenance")
        requested = inputs.get("source_sha", "") or tooling_sha
        if requested != source_sha or not re.fullmatch(r"refs/heads/[A-Za-z0-9_./-]{1,200}", ref):
            raise Unknown("dispatch-ref-mismatch")
    else:
        raise Unknown("unsupported-event")
    return {"repository": "Jones-Systems/lift", "source_sha": source_sha,
            "tooling_sha": tooling_sha, "workflow_sha": workflow_sha,
            "workflow_path": WORKFLOW, "ref": ref, "event": event_name,
            "action": action, "base_sha": base_sha, "base_ref": base_ref}


def fingerprint(value, domain=DOMAIN):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True).encode("ascii")
    return hashlib.sha256(domain + encoded).hexdigest()


def observe(source, tooling, env, event, executing=None):
    result = {"schema": SCHEMA, "mode": "full", "identity_status": "unknown",
              "reuse": "unknown", "input_digest": "", "record_digest": ""}
    try:
        origin = provenance(source, tooling, env, event)
        head, merge = origin["source_sha"], origin["tooling_sha"]
        inputs = {
            "head_app": entry(source, head, "apps/form", "tree"),
            "head_attributes": entry(source, head, ".gitattributes", "blob", optional=True),
            "tooling_driver": entry(tooling, merge, "apps/form/scripts", "tree"),
            "tooling_workflow": checked_out_blob(tooling, merge, WORKFLOW),
            "tooling_helper": checked_out_blob(tooling, merge, HELPER, executing),
            "tooling_self_test": checked_out_blob(tooling, merge, TEST),
        }
        for item in git(tooling, "ls-tree", "-rz", merge, "--", "apps/form/scripts").split(b"\0"):
            if item:
                metadata, name = item.split(b"\t", 1)
                mode, kind, oid = metadata.split()
                path = Path(tooling) / name.decode("utf-8")
                if (path.is_symlink() or not path.is_file() or
                        bool(path.stat().st_mode & 0o111) != (mode == b"100755") or
                        path.read_bytes() != git(tooling, "cat-file", "blob", oid.decode("ascii"))):
                    raise Unknown("tooling-driver-mismatch")
        # This is intentionally not a static JS dependency parser. Install hooks,
        # config, computed imports and Metro resolution need a future closure proof.
        # Even a well-formed fingerprint is never a reusable native identity here.
        payload = {"schema": SCHEMA, "launch": "public-disabled-api-unsigned",
                   "inputs": inputs, "dependency_guard": "unverified", "mode": "full"}
        record = {**payload, "provenance": origin}
        result.update(input_digest=fingerprint(payload), record=record,
                      record_digest=fingerprint(record, RECORD_DOMAIN),
                      reason="dependency-closure-unverified")
    except (Unknown, KeyError, TypeError, ValueError, UnicodeError, OSError) as exc:
        result["reason"] = str(exc) if isinstance(exc, Unknown) else "invalid-provenance"
    return result


def emit(result, env):
    # Only fixed enums, bounded reason codes and hex enter Actions output syntax.
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for key in ("input_digest", "record_digest", "mode", "identity_status", "reuse"):
                output.write(f"{key}={result[key]}\n")
    encoded = json.dumps(result, sort_keys=True, ensure_ascii=True)
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("### Native input observation (not a reuse receipt)\n\n```json\n")
            summary.write(encoded + "\n```\n")
    print(encoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--tooling", type=Path, required=True)
    args = parser.parse_args()
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
            event = json.load(stream)
    except (OSError, KeyError, ValueError):
        event = None
    emit(observe(args.source, args.tooling, os.environ, event, __file__), os.environ)


if __name__ == "__main__":
    main()
