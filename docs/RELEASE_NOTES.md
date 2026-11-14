# Open Harness 0.4.0-beta.1

**Unreleased draft — 2026-10-03.** The contract-9 native AMD64 Hermes
candidate passes strict HIGH/CRITICAL vulnerability and secret scans, with no
exceptions. Final coordinator/engine security gates, both architectures' published
input identities, packaged installation, upgrade/rollback acceptance and a
qualifying final-image 24-hour soak remain release requirements. Historical
passes apply only to their recorded images. No prebuilt images or browser release
archives have been published. See the
[verification record](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/runtime/VERIFICATION.md)
and [release checklist](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/BETA_RELEASE.md).

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

Folders now has a workspace list with lasting per-agent read/write grants.
Projects can grant folders for their own runs; revocation applies to subsequent
runs. The named paths are `/workspace/folders/<name>` and
`/workspace/project/<name>`, replacing `/workspace/mounts/folder-N`. Update scripts
that use the old paths.

Credentials now supports API keys, bearer tokens, Basic authentication, header
sets and OAuth2 with PKCE or client credentials. Enable authenticated API requests
with explicit credential, HTTPS-origin and method grants; credentials are resolved
by the coordinator. MCP connections can receive selected credential fields.
File fallback encrypts the store with a separate key. Keep its original
`secrets.json.key` or deployment-supplied `OPEN_HARNESS_ENCRYPTION_KEY` when backing
up or restoring; changing the key does not rotate the store. See the
[credential guide](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/CREDENTIALS.md).

Agents can now reliably create and update task cards with API-key models. Agent
settings → Tools → **Workspace access** adds per-agent Projects, Routines, Teams and
agents, and Runs and conversations permissions, all off by default. The old
"Create and change projects" switch is retired: turn on **Projects** again for any
agent that should manage projects.

Requests go to the model provider you configure and may incur provider charges.
Open Harness sends no product telemetry.

Before updating, follow the [self-hosting operations guide](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md)
and take a [backup with all writers stopped](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md#backup-and-restore).
Backups contain credentials and private files; protect them accordingly and back up
exported host folders separately. For
[rollback](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/docs/SELF_HOSTING.md#update),
restore the pre-update backup into empty volumes with the matching older release.
Never open a database migrated by newer code with an older release. Older code also cannot read the new encrypted credential
format and may replace its control token; restore the complete pre-update
credential store and original key when rolling back.

Report ordinary bugs through the [GitHub issue tracker](https://github.com/sflow-hub/OPEN-HARNESS/issues).
Include the version, OS, Docker version and reproduction steps. Review the in-app
diagnostic bundle before attaching it; it excludes prompts, responses, file contents
and credential values. Report suspected vulnerabilities privately through the
[security reporting process](https://github.com/sflow-hub/OPEN-HARNESS/blob/main/SECURITY.md#reporting-a-vulnerability).
