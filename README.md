# lift

The temporary public code-development and test repository for Form. Keep a
matching private Form PR for each code change; see
[PAIRED-DEVELOPMENT.md](PAIRED-DEVELOPMENT.md).
The source revision and publication exclusions are recorded in
[SOURCE-SNAPSHOT.json](SOURCE-SNAPSHOT.json).

Open **Actions → Lift iOS simulator → Run workflow**. Select a branch and leave
`source_sha` empty to build that branch's current commit, or provide a full
40-character commit SHA already pushed to this repository. The workflow uses a
standard GitHub-hosted Apple Silicon runner with Xcode 27.

From the command line:

```sh
gh workflow run form-ios-simulator.yml --repo Jones-Systems/lift --ref build/lift
```

After the run, download its `lift-ios-…` artifact from Actions. Artifacts are
retained for one day. The artifact contains `Form-simulator-arm64.zip`, launch
screenshot, logs and a manifest tying the result to the source commit. The ZIP
contains an unsigned app for an Apple Silicon iOS simulator; it is not a
physical-device IPA or an App Store build.

The build embeds a disabled loopback API destination (`http://127.0.0.1:9`) and
uses no accounts, signing credentials or private backend. It checks compilation,
installation, process survival and screenshot capture. These checks do not prove
authenticated product flows. See [BUILD.md](BUILD.md) for commands and limits.

`apps/` contains native app and website code, `services/api/` contains backend
source, and `packages/` contains shared adapters. Private research, owner captures,
operational evidence and source Git history are excluded. The full backend
research projection build and tests that depend on that corpus require the
private Form repository. The selected public checks and their limits are
listed in [PUBLIC-TESTING.md](PUBLIC-TESTING.md).

Standard hosted macOS compute is free for public repositories under
[GitHub's runner rules](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Artifact storage and service limits remain separate. This setup does not change
billing settings or remove existing artifacts.

This started as a snapshot and is not an automatic mirror. New source must be
scanned and exported deliberately; never push the private repository's Git history here.
Preserved asset and upstream notices are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). No additional project-wide
license is granted by this snapshot.
