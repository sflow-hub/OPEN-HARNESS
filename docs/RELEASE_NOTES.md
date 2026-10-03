# Open Harness 0.4.0-beta.1

**Unreleased draft — 2026-09-29.** The reviewed Linux ARM64 coordinator, Hermes and
private-engine build snapshots passed strict HIGH/CRITICAL vulnerability and secret
scans; their exact identities and coverage are recorded in the
[verification record](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/runtime/VERIFICATION.md).
Publication still requires final image and source integration, ARM64 and AMD64
Docker build/execution evidence, and the final-image 24-hour soak. Recorded emulated
execution is acceptable; physical Mac/Windows checks and native installers are
outside the MVP release gates. The final release images must pass their own
security and acceptance gates. No prebuilt images or browser release archives have
been published. Finalize this status against the exact release evidence using the
[release checklist](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/BETA_RELEASE.md)
before publishing.

Open Harness is a local-first named-agent workspace for **one trusted operator**.
The beta targets Linux containers with a local browser; advanced features, including remote runners, team
coordination, scheduling and third-party integrations, remain experimental. A
paired browser has full operator authority. Read the
[security model](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/SECURITY.md)
before granting access or configuring remote connectivity.

This candidate adds a Docker-backed local browser package with Mac and Windows
launchers, one-use browser pairing, and digest-pinned coordinator, Hermes and
private-engine images. The planned prebuilt installation needs Docker without a
host Node.js, Python or Git installation. Exact shipped containers and browser flows
still require acceptance; host-specific Docker Desktop integration remains unverified.
See the [local browser guide](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/LOCAL_BROWSER.md)
for the installation contract and current limits.

Each agent runs in its own container with private files and a private Linux desktop.
Agents retain the workspace's shared folder. Host-folder access is opt-in through
explicit read-only or writable exports and per-agent grants. Closing the browser
leaves active work running. Ubuntu ARM64 checks exercised the real runtime and
packaged browser flow with a scripted local provider; these checks establish tool
and transport behavior, not model reasoning or native Mac/Windows compatibility.

Requests go to the model provider you configure and may incur provider charges.
Open Harness sends no product telemetry.

Before updating, follow the [self-hosting operations guide](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md)
and take a [backup with all writers stopped](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md#backup-and-restore).
Backups contain credentials and private files; protect them accordingly and back up
exported host folders separately. For
[rollback](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md#update),
restore the pre-update backup into empty volumes with the matching older release.
Never open a database migrated by newer code with an older release.

Report ordinary bugs through the [GitHub issue tracker](https://github.com/sflow-hub/OPEN-HARNESS/issues).
Include the version, OS, Docker version and reproduction steps. Review the in-app
diagnostic bundle before attaching it; it excludes prompts, responses, file contents
and credential values. Report suspected vulnerabilities privately through the
[security reporting process](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/SECURITY.md#reporting-a-vulnerability).
