# Runtime verification

## September 29: Docker-and-browser scope and actual emulation prerequisite

The user removed physical Mac/Windows hardware and native AMD64 hardware as MVP
prerequisites. The release checklist now requires per-architecture Docker/browser
evidence and allows explicitly recorded emulation. Existing security, isolation,
exact-image, upgrade/restore and final 24-hour soak requirements remain.

On the existing Ubuntu ARM64 runner, a fresh `docker-container` Buildx builder used
the retained official BuildKit image
`sha256:5a8cd84cb3fcfd082789a08f92bd36f8e745c6231edd78e24a3bf34fd471a823`.
A no-cache build of pinned Debian index
`sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a`
executed `uname`, `dpkg --print-architecture` and `getconf LONG_BIT` for both targets.
ARM64 reported `aarch64` / `arm64` / `64`; emulated AMD64 reported
`x86_64` / `amd64` / `64`. Target labels matched. The build took 3.4 seconds and
its RUN steps had networking disabled. Host and Docker daemon remained ARM64.

BuildKit's bundled emulator needed no host package installation or binfmt changes.
The temporary builder was removed, no outer containers remained, and the default
builder was not changed. Evidence is retained under
`docker-emulation-v1-p7apiusz` on the runner and in
`Claude outputs/runtime-recovery-20260928/docker-emulation-v1-result.json`.
This proves target command execution via Docker emulation, not application acceptance,
AMD64 engine component builds, physical Docker Desktop behaviour or release readiness.


The unchanged reviewed runc-builder-v2.1 context then built an actual AMD64
builder image in 110.077 seconds under the same pinned BuildKit:
`sha256:f1cf45dc887f3427986327e5c355dd2126628963c55c00ea69097755af214fca`.
The image uses the named UID/GID 1000 account. The build wrapper's post-build
`docker cp` failed because it could not populate a mode-0555 local directory;
that failure is retained. A separate read-only tar-stream inspection recovered
and hashed all 25 provenance files and checked the unchanged build sources,
without rerunning the build or modifying the image.

A direct restricted container also passed on this AMD64 image. The official
BuildKit ARM64 `buildkit-qemu-x86_64` binary, SHA256
`5e3eb921f26f576b3722207bbf5a192ba099032924eb7d0f4104bb1b536e5f51`,
was mounted read-only at `/dev/.buildkit_qemu_emulator` and used as the entrypoint.
UID 1000 Python successfully spawned a shell, `uname`, `dpkg` and `gcc`; reported
values were `x86_64`, `amd64` and `x86_64-linux-gnu`. The container had a read-only
root, no network, all capabilities dropped, no-new-privileges and a 64-process
limit. Its exit was zero; all fixture containers were removed and host binfmt
entries were unchanged. This establishes a concrete direct-container emulation
mechanism for builder phases, not nested-engine or application acceptance.
Build failure and postflight records are retained under
`amd64-builder-emulated-v1-s0of6g7l` and the local recovery folder.
A further clean-environment run of the fully verified 16,703-entry AMD64 Go tree
reported `go version go1.26.8 linux/amd64` as UID 1000 through the same restricted
container mechanism. The tree remained mounted read-only. Combined evidence
archive SHA256 is `e18cf2e482e2e21a54bd7b2de008b9e80a39ca141b71724f870bf3be87151dba`;
all 51 payloads and the manifest were verified after transfer.


## Portable phase controllers and native bootstrap — September 29, 2026

Claude's `portable-engine-recipes-v2` adds only the independently reviewed AMD64
Go executable checksum to the two phase controllers. Both recipes and every
ARM64 input pin remain unchanged. Runc AMD64 still refuses its unreviewed static
inputs; Buildx advances to the existing host, daemon, image, account, full-tree
and bootstrap checks. This is not native AMD64 acceptance.

Root verified the 37-member delivery ZIP and all 36 payloads, and applied the
patch to a fresh v1 copy: all 17 source/tool files match the proposal. ZIP SHA256:
`13f6233c3c5bd3a3f1b89ff13a985f6c7726cb42380e607bef31805f4a8330ca`.
Independent Ubuntu Python 3.12 tests passed 157/157 with no skips. These tests
use Docker/host/Go stand-ins; the Buildx recipe tests read the retained real
source archive. All 51 staged inputs remained unchanged.

The exact new phase controllers then completed real ARM64 bootstraps using the
accepted runc builder `487f193cb414ff86ee2a29daf2306941e3392cfa5807920e34b553d6cf78b8cf`.
The phases verified the complete 16,703-entry Go tree before and after execution,
actual Go 1.26.8 ARM64 identity, and the named `oh-build` UID/GID 1000 account.
Runc recorded 47 tools and all 11 retained static inputs; Buildx recorded four
tools. Their bootstrap hashes are respectively
`732d03d81d5525e1e7ff828ed219caf8545ccc024fb821a02e8bf81f37656e2a` and
`d46c5547675bd00546c0b736d488b5a26958621094d6aa695e7fe472608cfdec`.
Both container processes exited zero, and both exact containers were removed.

The outer wrapper subsequently failed its full-image equality assertion because
Docker reversed two `Identity.Pull` repository entries for an unrelated retained
coordinator image. The failed record is preserved. A separate read-only postflight
proved this was the sole difference, sorting only that list and retaining every
field/value. All 44 image records otherwise match. It also completed the skipped
postconditions: all ten staged source files and the four-file phase packet are
unchanged, every controller has exited, and no outer containers remain. Neither
bootstrap was rerun or its result rewritten.

The 109-member, 108-payload evidence archive and every payload's hash and mode
were verified after transfer: `Claude outputs/runtime-recovery-20260928/portable-engine-root-v2/evidence.tar.gz`,
SHA256 `3760c22023239bee771a09b7b3836a8aa2c1301f7e6ce3a156ce7cdebb8b7f2f`.
This covers bootstrap only: no new materialization or component compilation,
no native AMD64 execution, and no relabeling of retained ARM64 artifacts.
Mac/Windows acceptance, native AMD64 builds, final source/image integration,
final-image 24-hour soak and release authorization remain outstanding.

## Portable builder controllers — September 29, 2026

Claude's four build/inspection controllers now require an explicit native platform,
non-root UID/GID and canonical operator home. They check the host, Docker daemon,
local pinned base, output image, and the image's architecture/account records.
They refuse optimized Python so assertions cannot disappear, and recover an
exact nonce-owned inspection container when `docker create` times out after
creation. Existing ARM64 records are refused by the new inspections rather than
relabeled. The builder Dockerfiles and their scripts are unchanged.

Root verified all 27 delivery ZIP members and 26 payload hashes, then independently
ran all 35 offline tests on native Ubuntu Python 3.12 with no skips. Those tests
simulate Docker and host identity; they do not establish native AMD64 execution.
The patch reproduces the proposal exactly. Delivery ZIP SHA256:
`278029f2cccd67191b76308c4cf5303c399e2373cc136007b756d9f1eebbfc34`.

Both controllers then built and inspected actual ARM64 builder images on Ubuntu.
The containerd builder completed in 2.50 seconds with build caching; the runc
builder used its retained `--no-cache` command and completed in 26.44 seconds.
Both images use UID/GID 1000. Their copied architecture, account, script and
provenance records were independently verified (36 containerd files, 29 runc
files). Runc's 11-entry static-input manifest still hashes to the retained
`528d1c4d2df18fa29025d534ffe0b7ec60594e1a5bbeaa7f026ca96cc4b4bf1e`.
Both never-started inspection containers were removed and all controller/build
processes are absent. All 68 staged source/input files and all 42 pre-existing
full image inspection records were unchanged.

The new builder IDs are `4b8e0f722f159073e44c3bf39423438e11a60b0a8e00c010799c3f476300f5f7`
(containerd) and `487f193cb414ff86ee2a29daf2306941e3392cfa5807920e34b553d6cf78b8cf`
(runc). These are builder images, not new shipping component binaries.
The 147-member, 146-payload evidence archive was verified after transfer:
`Claude outputs/runtime-recovery-20260928/native-builder-controllers-root-v1/evidence.tar.gz`,
SHA256 `754ad12750caf70b8fb4a9e0ec6baac36ae5291376b01f67f62eb2892b3d12c5`.
Native AMD64 builds, static-input review and platform acceptance remain pending;
retained ARM64 component artifacts keep their original provenance.

## AMD64 builder metadata and signed package review — September 29, 2026

The official Docker registry responses now bind both pinned builder indexes to
their AMD64 manifests and configuration digests. All six response byte streams,
descriptor sizes and Linux/AMD64 declarations were checked. Ubuntu's configuration
is `6232b38791000e3818b58d8847b5a8f5612d606929e01156dd8febc423e0f2ef`;
Debian's is `ec92d6b34c6a7e6372d87dc9ef2fd6e8ca8125353fe7d033c676f51cf923a13b`.
No layers were downloaded or AMD64 code executed. Native builder, compiler,
static-library and platform acceptance remain outstanding. The 12-member,
11-payload metadata archive was verified after transfer: SHA256
`9f51644cc2c8986f6baf20f4c455791380f69bd420ffbb5535ff04dffc59e3a6`,
under `Claude outputs/runtime-recovery-20260928/amd64-builder-bases-v1.tar.gz`.

A separate data-only Expat check used the accepted ARM64 engine's native `apk`.
Its first attempt stopped at `apk --help` before repository access. Cleanup then
rejected an inherited anonymous volume; independent inspection proved that exact
volume empty and owned only by the test container, and both were removed.
The corrected attempt replaced the inherited volume with a restricted temporary
mount, reached Alpine's x86_64 indexes, and stopped on `UNTRUSTED signature` for
both repositories. No package was accepted and no signature verification bypass
was used. Both controllers and their containers are gone; the engine's full image
inspection is unchanged. The 56-member, 55-payload failure/cleanup archive was
verified after transfer: SHA256
`9ce2bd5b926641b456aaee1dd4902520159b79f3a37bef8a86534ef581171fa4`,
under `Claude outputs/runtime-recovery-20260928/amd64-expat-failures-v1.tar.gz`.

Read-only inspection then established the cause: the image's default key directory
contains only ARM64 keys, while the same image already bundles Alpine's AMD64 keys
under `/usr/share/apk/keys/x86_64`. After checking all three bundled key hashes, a
third attempt used apk's documented `--keys-dir` option for that directory. Both
indexes and the Expat/musl package signatures verified with HTTPS and signature
checks enabled. No new trust key was installed. Expat's SHA256 is
`2e56946bc495cbed9eb1ad70859a79cba9db6420016453e065a0628848b32c7e`.
Independent archive inspection confirms Expat 2.8.5-r0, x86_64 package metadata,
and an AMD64 ELF library. No AMD64 package was installed or executed.
The successful check and key inspection retain 53 archive members and 52 verified
payloads: `Claude outputs/runtime-recovery-20260928/amd64-expat-inputs-v3.tar.gz`,
SHA256 `e6102dbcd5b577e32ef2fcaf639da548c8648db4e6d99599ba83ea1305c213fa`.
All owned resources were removed, the controller is absent, and the accepted ARM64
engine image is unchanged. Both earlier failed attempts remain archived.
The key-directory option is documented in the
[official apk manual](https://github.com/alpinelinux/apk-tools/blob/master/doc/apk.8.scd).

The engine lock now distinguishes reviewed AMD64 metadata and signed package data
from missing native builds and execution. Both architectures remain incomplete;
the retained ARM64 files keep their original provenance. Its local input image
exists, but a published manifest digest is still missing. These metadata edits
change the lock hash; previously tested images remain evidence for their recorded
lock and are not relabelled as matching the updated lock.

## Upgrade fixture review and native rerun — September 29, 2026

Claude's independent review found five bounded fixture issues, with no blocker
for the earlier accepted run. The integrated three-file correction forces
`python -I -B` for historical/runtime byte inspection and the Ubuntu probe, so
image `PYTHONOPTIMIZE` settings cannot suppress their assertions. It also requires
all six probe inputs before resource creation, refuses special permission bits,
rechecks hashes when reading version/contract files, and checks the actual work
directory in the ordering regression test.

Root verified all 35 review ZIP members and 34 payload hashes before adoption
(ZIP SHA256 `a899034df2a97ee75cfc5f33b4379776f254e17de256bdc30b7f0cae78704a97`).
All 57 fixture tests passed on macOS Node 24 and native Ubuntu Node 22. Scoped
lint reported zero errors and the same pre-existing warning. Native offline
reproductions rejected a setgid file, omitted probe inputs and substituted bytes
on a content reread; the last uses in-process injection, not a path-swap race.
The corrected preflight admitted the real 221-file snapshot.

The full native ARM64 upgrade/rollback then passed in 336.5 seconds against the
same recorded production images and historical checkpoint described below.
Both Python probe paths worked with the new flags. Actual image inspection also
confirmed neither the historical nor runtime image sets `PYTHONOPTIMIZE`, which
supports the earlier run's result. All nine browser jobs, both exact 3,360-entry
restores, current UI denial/approval effects, credential rotation, private-desktop
click/type/screenshot checks and restart retention passed again. All 351 exported
source hashes and 221 current snapshot modes matched; no owned container, volume
or network remained, and the original two processes were absent. The screenshot
was inspected after transfer.

All 407 archive members and 406 payload hashes/modes were verified:
`Claude outputs/runtime-recovery-20260928/current-upgrade-root-v2/safe-evidence.tar.gz`,
SHA256 `aa6e4a21749b676e603c0b45800843d95cdf44c664a0bdc8668d0a99035e70b7`.
Six archived workflow files were verified in the archive but left unmaterialized
locally while workflow-path approval remains pending. Historical Git modes retain
the documented umask limitation. This is acceptance of the reviewed build snapshots
with a scripted provider; final source, other platforms, model reasoning, release
publication and the 24-hour soak remain separate requirements.

## Automated Debian-origin gate — September 29, 2026

The new `scripts/debian-origin-gate.py` passed all 13 steps on native Ubuntu
ARM64 against exact production runtime `f1cd4156500a…` in 56.0 seconds, using
Trivy 0.74.0 and the unchanged database updated September 29 at 06:53 UTC.
The component, SBOM and whole-image reports contained zero HIGH/CRITICAL
findings and zero secrets. The older Chromium negative control produced 468
severe findings covering 234 distinct advisory IDs, proving Debian lookup.
All 329 Ubuntu package identities matched the lock; the Debian component
matched 48 installed files, two links and five intentionally omitted files.

Both probes ran as UID/GID 1000 with read-only roots, no network, dropped
capabilities and resource limits. All 28 staged source hashes/modes, 12 gate
source hashes and 44 raw report/stream hashes were independently checked.
Scanner/database identities were unchanged. The read-only publication validator
accepted the real receipt, the original processes were absent, and no outer
containers remained.

A second native run changed one byte in the disposable extracted Chromium
component after its extraction container exited. The subsequent real binding
probe rejected it in 9.9 seconds. No success receipt was written, the publication
validator refused it, both probes were removed, and the shipping image remained
unchanged. This was an isolated artifact test, not a live host-folder path race.

Root review tightened cleanup to accept only an exact missing-container response;
a missing Docker socket or mixed error cannot establish absence. The corrected
Python suite passed 25 tests natively; seven Node validator tests passed on
Ubuntu Node 22 and macOS Node 24. Scoped TypeScript and lint passed after adding
the required `NODE_ENV` declarations to two test child environments.

All 120 archive members and 119 payload hashes/modes were verified after transfer:
`Claude outputs/runtime-recovery-20260928/debian-release-gate-root-v1/safe-evidence.tar.gz`,
SHA256 `bb151c4cf138b6c14bd35d459c6c2bc4b226dd8904ad6f6949509e40370620a6`.
The first independent review script incorrectly compared split scanner versions
with lock tuples; its failure is retained, and the corrected review checks full
epoch/version/release plus architecture. No runtime rerun or threshold change was
needed. The isolated Node aggregate's missing-workflow failure is also retained.

Seven non-workflow proposal files are integrated. Claude's device bridge refused
the `.github/workflows/release.yml` write; local application of its reviewed
25-line addition and the eighth workflow assertion await explicit approval.
This evidence accepts only this ARM64 image/scanner/database gate, not workflow
execution, AMD64, Mac/Windows, final-source release acceptance or a 24-hour soak.

## Current production snapshot upgrade and rollback — September 29, 2026

The historical upgrade fixture passed on native Ubuntu ARM64 in 351.6 seconds,
using the unchanged `603b19b…` historical checkpoint and the current recorded
production runtime `f1cd4156500a…`, coordinator `92fad68ff028…` and private engine
`63004ab1782e…`. Nine real browser jobs exercised the original installation,
paired upgraded deployment and original-backup rollback. Current UI denial kept
the proof file at mode 0600; approval changed it to 0666. Original approval and
desktop capability limitations remain explicit in the fixture.

Both empty-destination restores matched all 3,360 backup entries, including file
contents, modes and owners. Profiles, original revision JSON, completed history,
private/shared files, memory, skills and task data survived. The restored credential
was used, its replacement was used after rotation, and a coordinator restart kept
the resulting state. Actual click/type/screenshot checks passed on one private
desktop while the second agent remained isolated. All owned containers, volumes
and networks were removed; both original process IDs were absent on review.

The new fixture option identifies current source as a reviewed build snapshot,
not a Git commit or the latest dirty checkout. Its complete 221-file coordinator
manifest and 24-file runtime manifest bind hashes and modes to pinned raw build
results and configured image IDs. Preflight rejects missing/extra files, unsafe
paths, symlinks, changed modes, mismatched builds and runtime contracts before
creating resources. Snapshot input and exported modes were exact; historical Git
modes retain the earlier fixture's documented umask limitation. All 351 exported
source hashes remained unchanged, and 54 offline fixture tests passed on both
macOS Node 24 and Ubuntu Node 22.

A read-only, network-isolated, non-root probe also rechecked all 329 installed
packages and rederived the Debian inventory from actual retained archives and
installed files: 48 files, two links and contract 7 matched. The coordinator's
copied Hermes, Ubuntu and installer source bytes were inspected independently.
The 404-member archive and all 403 payload hashes/modes were verified after
transfer; the desktop screenshot was inspected:
`Claude outputs/runtime-recovery-20260928/current-upgrade-root-v1/safe-evidence.tar.gz`,
SHA256 `42481059f69ccd0a0cd52047a279e56750a3a74d7b8925d2e482e09af06abc94`.

This establishes upgrade/rollback behavior for those production build snapshots
with a scripted local provider. It does not establish model reasoning, final
source/release acceptance, native Mac/Windows/AMD64 support or a 24-hour soak.
The upgrade browser's reopen checks retain its cache; the separate v7 evidence
below establishes cache-free server replay on the same images. The independent
review and corrected native rerun are recorded above.

## Integrated mock suite on native Ubuntu — September 29, 2026

The current source also passed the complete `npm test` command on native Ubuntu
ARM64, Node 22.23.3/npm 10.9.9, with an isolated HOME/TMPDIR and required release
archive/Compose tools enabled. Of 249 tests, 246 passed, zero failed and three
were skipped: the non-Linux rejection check and two unavailable PowerShell
launcher tests. The Linux directory-pinning, simulated password-vault failures,
and Compose CLI configuration/archive round-trip checks ran successfully. All 222 staged
source hashes/modes remained unchanged; the original supervisor/test processes
were absent and no containers remained. The supervised run took 26.5 seconds.

All 230 archive members and 229 payload hashes/modes were independently checked
after transfer, including the complete selected source snapshot:
`Claude outputs/runtime-recovery-20260928/full-node-current-native-v1-safe-evidence.tar.gz`,
SHA256 `5e6c5374fece19b93d8dfd303aea8588e3c670f41c13dfd09640d08cd7670579`.
These mock tests complement the real-container checks below. They do not prove
physical Mac/Windows operation, real OS-vault behavior, model reasoning or release
acceptance.

## Current production image sandbox enforcement — September 29, 2026

The dedicated native ARM64 sandbox fixture passed eight checks against runtime
`f1cd4156500a…`: separate profiles/private files, intentional shared read/write
access, rejection of non-directory and symlink grants, non-root execution with
no effective capabilities and enforced seccomp/no-new-privileges, actual cgroup
CPU/memory/process limits, safe profile regeneration, read-only/read-write folder
behavior, grant revocation on return to a private workspace, and stopped cleanup.
The read-only folder and host sentinel stayed unchanged, the writable folder
changed as intended, and both agents retained their distinct private owner files.

The first run passed its functional assertions, but the outer observer used a
plain path instead of the hashed workspace label and captured no image samples.
That attempt remains intact. The test now records and checks each container's
actual `Image`, checks the tag before/after, and writes success evidence only
after cleanup. The corrected run `production-sandbox-v2-3mizk5_2` passed in 3.3 s;
all four container identities match the production image, and seven independent
observer samples agree. All 222 source hashes/modes were unchanged, both runs'
original processes were absent, and no fixture containers remained. Syntax and
targeted lint passed. No application runtime or sandbox policy changed.

The 16-member/15-payload archive was independently verified after transfer:
`Claude outputs/runtime-recovery-20260928/production-sandbox-v2-safe-evidence.tar.gz`,
SHA256 `497a7edf284e0ac19aa5f6d7293144037f7a04e3e3efa58f1dfce5646467ad05`.
These are direct kernel/filesystem checks on native Ubuntu ARM64 with no model
calls. They do not include a live path-swap race, other-platform acceptance,
the final 24-hour soak or release qualification.

## Integrated mock suite on macOS — September 29, 2026

The full current Node test command passed on Node 24.19.0 in the macOS VM:
249 tests, 241 passed, eight skipped, zero failed (21.0 seconds). Because this
local runtime provides Node without npm, the repository's Node-version guard and
exact `test` script command were invoked directly, with `OPEN_HARNESS_MOCK=1`.
The initial npm lookup failure and first test run are preserved. That run exposed
two file-backend tests selecting the real macOS Keychain and a concurrency test
assuming its first HTTP request would win. The test subprocesses now explicitly
select the restricted-file backend; the concurrent-input test checks the actual
successful request and rejects persisted plaintext from either contender.
Production storage and dispatch behavior were not changed.

Scoped typecheck and lint passed. Typecheck excludes the existing unreadable
duplicate `tests/* 2.ts` and generated/evidence trees. Logs and before-edit copies
are under `Claude outputs/runtime-recovery-20260928/full-suite-repairs-v1/` and
`full-node-suite-current-v{1,2,3}.log`. These mock checks do not replace the native
Docker, OS-vault or physical-platform acceptance gates.

## Current production runtime approval effects — September 29, 2026

`production-approvals-v1-uk122wuq` passed the actual Hermes container fixture in
19.6 seconds with runtime `f1cd4156500a…` and the frozen current coordinator
source. The fixture checked mode `0600` before each approval, observed denial
leave it at `0600`, observed approval change it to `0666`, and restored `0600`.
Independent readback confirmed both approval request/resolution/completion event
sequences, four completed runs, retained file contents, absence of the prohibited
terminal artifact, distinct sessions with conversation continuity, and cleanup.
Seventeen actual container samples bind execution to the expected image and
only the managed profile, policy, private and shared directories. All 222 frozen
source hashes/modes remained unchanged; supervisor, worker, coordinator and
containers were absent after completion.

The 12-member/11-payload archive was independently verified after transfer:
`Claude outputs/runtime-recovery-20260928/production-approvals-v1-safe-evidence.tar.gz`,
SHA256 `0dbb871d25c217f2bf16baac42c87d3bfe6efea58da1322db1016cb0ed633815`.
This is native Ubuntu ARM64 using a scripted local provider and authenticated
API decisions. It does not establish approval UI behavior on the current-image
upgrade path, model reasoning, other platforms or release readiness.

## Continuous restart observation and current-image rehearsal — September 29, 2026

The soak now keeps a synchronized Docker event stream for all three service
containers. It accepts exactly one planned coordinator sequence: SIGTERM, exit
zero, start and restart. Unexpected lifecycle events or loss of the event stream
fail the run. Native controlled tests rejected a crash before the manual restart,
a crash after it, and a terminated event monitor; the healthy sequence passed.
An independent native experiment showed why `RestartCount` alone is insufficient:
an automatic restart increments it, but a manual restart resets it to zero.
The first negative probe exposed a race in the initial guard and is preserved
alongside the corrected four-case run. Twenty focused unit tests, scoped typecheck
and lint passed. The combined 163-member/162-payload native evidence archive is
`Claude outputs/runtime-recovery-20260928/soak-lifecycle-native-evidence-v1/`,
SHA256 `ae59215271e633fa98441818655e27e9e6d7e247dfb7080d1286679ab76c43af`.

The corrected source then passed `compose-soak-smoke-v7-j5_mha4u` on the same
production ARM64 images listed below. The full fixture took 510.5 seconds; its
312.4-second soak completed 11 cycles, 32 resource samples and exactly the four
planned lifecycle events. Every cycle replayed the server history without the
workspace cache, verified the agent's private/shared files, and stopped its
container. The full fixture also passed private-desktop click/type checks and
the 179-entry empty-volume restore. Independent terminal review verified all
222 source hashes/modes, six actual original/restored service image identities,
runc/Buildx bytes and complete fixture cleanup. The transferred archive has 99
members and 98 independently verified payloads:
`Claude outputs/runtime-recovery-20260928/soak-smoke-v7-safe-evidence.tar.gz`,
SHA256 `0f673e8c3baca06924b583a1f9830e923355bf2cc1b14d76ea2761c68f81d2cb`.
This closes the previously identified planned-restart observation gap for the
tested native ARM64 path. It remains a five-minute scripted-provider rehearsal;
final-image 24-hour duration, other platforms and release acceptance are pending.

## Current-image browser and transport acceptance — September 29, 2026

Native ARM64 `compose-soak-smoke-v6-loxt67rh` passed the full real Compose fixture
and a 311.5-second browser rehearsal using runtime `f1cd4156500a…`, coordinator
`92fad68ff028…` and engine `63004ab1782e…`. The entire fixture took 493.5 seconds.
All 221 staged source hashes/modes stayed unchanged. Independent observations
bound all six original/restored service containers to those images and checked
the engine and coordinator's actual runc/Buildx bytes. Both projects' containers,
volumes and networks were removed, with no unlabelled helper containers remaining.

The fixture exercised real tool dispatch, clarification/policy behavior, credential
rotation, explicit folder grants, two private desktops, shared files and a
179-entry backup into a separate empty restore volume. The captured desktop
shows the verified click and typed-input markers. Eleven subsequent runs
alternated two agents, with six inputs answered through the API while all browser
pages were closed and five answered from the reopened browser. Every completed
reply was replayed after clearing the workspace caches and checking the page's
own server history response. Pairing persisted through one observed coordinator
restart, with service IDs unchanged and only the coordinator's start time changed.
All 32 resource samples passed; the largest observed wall-clock gap was 19.4 s
and wall/monotonic divergence stayed below 1 ms. This is a five-minute rehearsal,
not a 24-hour qualification or proof of model reasoning.

The 97-member/96-payload archive was independently verified after transfer:
`Claude outputs/runtime-recovery-20260928/soak-smoke-v6-evidence/evidence.tar.gz`,
SHA256 `99c4dae6127a10d105d22ca12811899ce16736a044906a4bf142d4eb26d72a0a`.
The independent journal checker found no problems and correctly reports
`qualifies24h: false`. Its start-time check could not distinguish a rapid automatic
restart within the planned restart's observation window. The subsequent v7
continuous-event implementation and native fault tests above address that gap.

The actual production runtime's curl also passed separate HTTP/2 and HTTP/3 TLS
smoke tests, each transferring 262,144 hash-verified bytes with successful
certificate verification. Each corresponding untrusted-certificate check exited
60, returned no body and caused no application request at the server. Both
servers used private, network-disabled namespaces; clients joined only their
fixture server's namespace. All six containers ran non-root with read-only
roots, dropped capabilities and narrowly scoped fixture mounts; all were removed.
The 75-member/74-payload archive is `production-curl-transports-v1-evidence/`
under the same evidence base, SHA256
`d432e3f8e1ca77f6c753e56b0151152385812dc0f8ae4090cf3915deac623185`.
These smoke tests close the basic final-image transport check; they do not claim
all skipped distribution tests, other architectures or platforms were exercised.

## Production contract-7 images and fresh scans — September 29, 2026

The integrated Ubuntu ARM64 runtime built in 540.7 seconds as
`sha256:f1cd4156500aac55dc3a0b1d4c1ae97093f76320d1b7d65748877c3aab6ad20e`.
Its default final target verified 329 locked package identities, 90 native files
and the Debian-origin inventory. All 24 staged source hashes/modes and 46
before/after image objects were unchanged. The 42-member receipt archive and 27
nested provenance payloads were independently verified (SHA256 `33deb853d4ace868b87243b015545ebef09a759508e25354e79498f3673abdd7`).
The complete curl log reports OpenSSL 1774/1775 OK with flaky test 1510 ignored
and 149 skipped, and GnuTLS 1772/1772 OK with 152 skipped. Both retain seven
HTTP/2 server-setup skips; OpenSSL also retains an HTTP/3 server-setup skip.
These distribution tests do not by themselves prove final-image protocol behavior.

The current-source coordinator built in 30.1 seconds as
`sha256:92fad68ff028655548b073553af0bb399e63137fc3750ef06f900e693e1a8ccd`.
All 221 staged hashes/modes and 46 existing image objects were unchanged. An actual
bundled-service probe served all 20 expected installer inputs with matching
hashes and rejected five restricted paths. It ran non-root, read-only and without
network access, using temporary mock state and no agent execution. Its 242-member
archive SHA256 is `9641cb2586741dea2e693598b4b5ef7d2c52f18e4be04279f291a458ff5e670a`.

The runtime, coordinator and retained engine `63004ab1782e…` passed strict
HIGH/CRITICAL vulnerability and secret scans using Trivy 0.74 and the database
updated at `2026-09-29T06:53:54.829248015Z`. All 13 scan/check steps returned their
expected exit codes. Package coverage was runtime 329 Ubuntu/332 Node/110 Python/
13 Go, coordinator 26 Alpine/205 Node/210 Go, and engine 53 Alpine/873 Go entries.
The supplemental Debian-origin rootfs and SBOM scans covered all three locked
packages, bound to 48 installed files and two links in the actual runtime. The
intentional old-Chromium negative control produced 468 severe findings across
234 CVE IDs. Scanner, database, lock and source hashes were verified unchanged;
raw reports and image identities were independently reviewed. The 65-member
archive SHA256 is `f3aea4595fb0e6e203cc9e61c7bd16476b9295c0261df725885c293a881da91c`.
The first collector mistakenly expected Debian's OS label to be `13`; the actual
pinned component label is `13.7`. The corrected collector reads the same reports;
both the initial error and corrected receipt remain available.

Evidence directories under `Claude outputs/runtime-recovery-20260928/` are
`production-runtime-v1-evidence`, `production-coordinator-v1-evidence` and
`production-security-v1-evidence`. These checks establish build and scanner
behavior on native ARM64. They do not establish final functional acceptance,
native AMD64/Mac/Windows acceptance, a 24-hour soak or publication readiness.

Claude's source-only soak audit was independently hash-verified and its six-file
proposal adopted. Fresh replay clears only the workspace caches, preserves
pairing, checks the page's own server history response and rendered reply, and
observes service container identities/start times. The loop now checks wall time
alongside monotonic time, and successful result files require fixture cleanup.
Root repeated nine baseline, 15 proposed unit and 17 simulated fault-scenario
checks, plus scoped typecheck and lint. These are offline tests; the next native
rehearsal must validate the adopted bytes before the full soak. Frozen delivery
manifest: `52ce2322e48971c56e3941cdd9f3dec649e7d6f9fe899a7d6de1feaf263df238`.
The supplemental scan still needs mandatory release-workflow/publication binding;
Claude has been assigned that separate proposal.

Eight unused legacy runtimes were retired only after a full shared OCI archive
and every referenced blob were verified. A further readback verified every
tag-to-image binding. The archive
is `legacy-runtime-images-backup-v1/legacy-runtimes.tar` (5,952,253,440 bytes,
SHA256 `7c4451e7ae91590d91b0be2800728cdd2eedb7e1bb788adb6d28ef1075c0e1ed`).
All 39 remaining complete image objects stayed unchanged; free space increased
from 18.53 GB to 32.58 GB. The 23-member `capacity-recovery-v2-evidence` archive
also preserves the preceding exact-image and cache retirement records (SHA256
`9ac24875f15c7a6d9fc06b5a1e3b2b6f46282639e4aeeacba81f594a02ffc065`).

## Portable runtime source integration — September 29, 2026

The first complete portable Ubuntu ARM64 build (`portable-ubuntu-runtime-v1-nknce_74`)
finished in 536.4 seconds, producing image `39e46deb34b4…`. The default final target
verified all 329 locked packages, 90 native files and the Debian-origin inventory.
Independent review confirmed all 25 staged hashes/modes and all 48 before/after
image objects unchanged. A later readback initially failed because Docker returned
one `Identity.Pull` list in a different order; both observations are retained, and
the corrected comparison sorts only that field. The 44-member archive and its 27
nested provenance payloads were verified after transfer; archive SHA256
`579a1a458066e63b0bd718bd47d0bf50f0dc245d055705278ddaf83afa368fdb`.
Evidence: `Claude outputs/runtime-recovery-20260928/portable-runtime-v1-evidence/`.

Complete curl stdout/stderr is retained. OpenSSL reported 1774/1775 tests OK with
149 skipped; GnuTLS reported 1771/1772 with 152 skipped. Both ignored flaky test
1510 under the unchanged distribution `test-nonflaky` policy. HTTP/2 server setup
and HTTP/3 setup/missing-feature skips remain. This is a successful distribution
build, not complete protocol coverage or final image acceptance.

The reviewed recipe and nine helper/lock inputs are now integrated into
`runtime/hermes/Dockerfile` and `runtime/ubuntu/`, under runtime contract 7.
Both runner installers, the coordinator image and the desktop bundle include the
new inputs. The public installer route retains an exact allowlist of source files;
its additions contain build helpers, constraints and locks, not credentials.
`runtime/runner.mjs` was regenerated. Native Ubuntu Python 3.12 ran 109 offline
checks with zero skips against the adopted source and retained evidence; all 22
new source hashes and 89 frozen evidence hashes stayed unchanged. The test receipt
archive is `922e216242413f37607bc6957f78436c6c5d2e2a255859e83b06cfbf2cd8a152`.
Local Node checks passed 51/51, including an actual POSIX installer download up to
the mocked Docker build boundary. Release packaging passed 20 checks with one
existing Docker Compose CLI skip on this Mac. Scoped lint and TypeScript checks
passed; the TypeScript configuration excludes the existing unreadable duplicate
`tests/runner-credential.test 2.ts`. PowerShell execution is not claimed.

The first service attempt selected this Mac's OS vault and failed an existing
file-store expectation; the documented headless setting passed all 27 service
tests. An initial typecheck configuration used the wrong relative root; that
failure and the corrected passing result are both retained.

To make room for final checks, three unused images were retired after full OCI
archive verification, followed by 34 exact unused, unshared regular cache records.
All 46 remaining complete image objects are unchanged. Free space increased from
4.42 GB to 23.76 GB. Recoverable archives retain the historical upgrade image
(`402a92cf…`), old diagnostic runtime (`fd221cc5…`) and old curl builder (`b4072fa0…`).
Before/after inventories and cleanup outputs are saved in
`Claude outputs/runtime-recovery-20260928/portable-capacity-recovery-v1-evidence/`.

The first build from the integrated contract-7 source and its initial fresh scans
are complete (see the later evidence above). Final runtime checks,
automating the mandatory supplemental Debian-origin release gate, native AMD64
and Mac/Windows acceptance, cache-independent browser replay and the final 24-hour
soak remain open. Nothing in this section establishes release readiness.

## First real browser soak rehearsal — September 29, 2026

Native Ubuntu ARM64 attempt `compose-soak-smoke-v5-vp7efkyz` passed the full
Compose fixture and then 310.9 seconds of repeated browser/agent checks: 11 unique
completed runs alternating two agents, 32 disk observations, and one coordinator
restart. Six inputs were answered through the API while all dashboard pages were
closed; five were answered through a reopened browser. Each cycle checked the
unique shared artifact, private-file owner, absent host/socket/peer paths, one
input resolution, and stopped agent container. The browser paired once and kept
that session through restart. The browser process/context remained open while
its pages were closed.

Independent review verified all 201 staged source files and modes unchanged,
the same three candidate image IDs, six actual outer container identities,
runc/Buildx bytes, the 179-entry empty-volume restore, and complete removal of
fixture containers, volumes and networks. Original supervisor/child processes
were absent. Total fixture time was 485.9 seconds; minimum outer free space was
7,467,933,696 bytes. The private-desktop screenshot was inspected. All 95 payloads
in the 96-member evidence archive were checked after transfer; SHA256
`1b58be036fb6da84c1913e31d20ad913d51897f8610bc3d206dfb195a01a18d9`.
Local evidence: `Claude outputs/runtime-recovery-20260928/soak-smoke-v5-evidence/`.

This is a five-minute rehearsal, explicitly `durationQualified: false`, against
the diagnostic Ubuntu runtime. It is not the final-image 24-hour soak. API event
history was compared across reload/restart, but the browser transcript can still
come from its local workspace cache. Claude's independent audit identified that
coverage limitation; cache-independent server hydration must be checked before
the final soak. The earlier failed rehearsals remain failed evidence.

The portable Ubuntu proposal also reached its first actual native build. Attempt
`portable-ubuntu-curl-v1-p2qx61qt` failed before compilation because Docker retained
mode 0700 on the staged helper directory, making it unreadable by the prescribed
UID 10001 builder. All 25 staged file hashes/modes and all 47 existing image
inspect objects were unchanged. The 14-member failure archive is
`39907695fb40073b32decbdbc7b829bba7d10c35dd3cacc4175f1dfbf95a9157`.
The immutable Claude proposal is preserved. An isolated root correction explicitly
sets read/traverse permissions on the public build helpers and locks; it retains
the non-root UID, offline build, source/patch locks, and distribution tests.

The corrected clean curl build (`portable-ubuntu-curl-v2-_vtenn2s`) exited zero in
305.5 seconds and produced ARM64 image `62e36d4ff8c2…`. Its retained invocation
confirms UID 10001, only loopback up, and `dpkg-buildpackage -us -uc -b -j4`, without
a resume or test override. The three runtime package hashes, original signed
sources, exact three-file patch and both flavour test command logs were recovered
from the image. All 25 input files and 47 pre-existing image inspect objects were
unchanged. BuildKit clipped console output at 2 MiB before the suite summaries,
so exact test counts are not claimed. The first evidence collector incorrectly
expected 16 retained `commands.log` files per flavour; actual counts are 11 and
12. That failed collector is preserved. The corrected 18-member archive is
`4ac1fd305501f5fe4b2903063943bf41cd7f706faba351277fe5f24d7e38fb44`;
both its payloads and nested build-provenance payloads were verified.

A second isolated helper correction retains complete build stdout/stderr and
propagates nonzero exits after recording them. All 24 targeted native Python
tests passed, including successful-output retention and nonzero-exit propagation.
The first complete portable Ubuntu runtime build subsequently passed with both
corrections and the mandatory final verification stage. Its detailed results and
later source integration are recorded above.

The proposed Debian-origin helpers were also exercised on the existing immutable
diagnostic image `19767a183a71…`, offline and with a read-only root filesystem.
They reconstructed the component from the image's authenticated archives and
bound all 48 installed files, two links, five policy-omitted files, installed
identities and Debian 13 metadata. All 11 scan/check steps then passed with the
retained scanner/database: component rootfs, component SBOM, SBOM scan, negative
control, and mandatory whole-image scan. The negative control changed both binary
and source versions and returned 468 HIGH/CRITICAL findings with exit 1; the
positive whole-image scan returned zero findings and secrets with coverage of
329 Ubuntu, 332 Node, 110 Python and 13 Go packages. The 40-member archive
`aeacb564043e3528034054b7e424e87fc19c37d40c640e405c5898290ad3c1a2`
was verified after transfer. This validates the proposed gate on the diagnostic
image; new portable images still need their own scans and fresh release data.

## Corrected Ubuntu stack acceptance and soak preparation — September 29, 2026

SSH access to the existing Ubuntu ARM64 runner resumed. The physical-host root
cause is not established here. Seven completed build trees were archived off-host
before removal: 210,884 entries, all file hashes, link targets, modes and owners
verified; archive SHA256
`440d210bf90a043529ddf6579fcbb548120b77711cf91ce8da53ff6d8342efba`
(1,888,788,420 bytes). The initial removal stopped on read-only Go-cache
directories after six entries. The remaining entries were checked against the
archive before adding owner-write to 14,629 archived directories owned by the
runner user and completing removal of those same seven trees. Original modes
remain in the backup. Both attempts and inventories are retained. All 47 remaining
image inspect objects are identical before/after; free space reached 23.10 GB.
The control-record archive is
`227e1accabcf048dba9bbf6231bf062feef5e16108562705fe6cea40e243f81e`.

The previously staged full Compose fixture then passed in 205.7 seconds against
Hermes `19767a183a71…`, corrected engine `63004ab1782e…`, and coordinator
`0c3efad0e0ce…`. Independent review confirmed all 198 source files unchanged, six
actual outer container identities, both engines' exact runc/Buildx bytes and
versions, coordinator Buildx identity, and complete removal of fixture containers,
volumes and networks. Real Hermes tools, clarification, task MCP, saved credential
rotation, denied terminal dispatch, history/restart, two private desktops, shared
files and explicit folder limits passed. Restore into an empty application volume
preserved all 179 entries with exact content/mode/owner comparisons, then resumed
real work and private desktop input using a fresh engine cache. The screenshot
was inspected. The lowest sampled free space was 7,545,503,744 bytes, above the
unchanged 4 GiB stop floor.

Native root: `compose-ubuntu-integrated-v1-trjvg2ex`; local evidence under
`Claude outputs/runtime-recovery-20260928/compose-ubuntu-integrated-v1-evidence/`.
All 45 payloads in the 46-member archive were verified; archive SHA256
`b25abd6a92d8a807a569d4cca7ad2e067f49008b436e9f141ab415e73474a3e0`.
This is Linux ARM64 tool/transport behavior with a scripted provider, not model
reasoning, native Mac/Windows acceptance, or production packaging adoption.

An opt-in Compose soak driver now exercises unique per-run file/tool results,
real browser close/reopen/input/replay, one coordinator restart, exact image and
fixture-source binding, disk measurements, and a durable journal. Full mode has a
fixed 24-hour duration and a minimum of 288 cycles; five-minute smoke mode cannot
qualify that duration. Ten offline tests pass on both macOS Node 24.19.0 and native
Ubuntu Node 22.23.3, including clock gaps, insufficient cadence/disk, failure
propagation and actual scripted-provider responses. Combined local soak and
release-packaging checks: 30 passed, one existing Docker-CLI-dependent skip;
scoped TypeScript and lint passed. The first real-browser smoke attempt stopped
before its first cycle because the durable evidence path exceeded Chromium's Unix
socket path limit. All fixture resources were removed, all 201 source hashes were
unchanged, and its 45-member failure archive
`a1b242f3575c0deb86c7357053a81f6374a82a00dbd40b17bfe3a4384827712e`
was verified. Only the browser child now uses a short temporary directory; durable
evidence stays in place. Actual Chromium startup and DOM readback then passed. A
fresh full fixture plus browser rehearsal is running; real soak acceptance is
still pending.
The full final-image soak, portable Ubuntu production recipe, native multiarch
builds, fresh scans, platform checks, release integration and publication remain
open.

Claude's portable Ubuntu packaging proposal has now been received: all 22
payloads and 23 ZIP entries were independently checked, manifest SHA256
`2b8ea6a102e02a52b0828630fef08d9b953e0b3d07930d78b0434987e4522730`,
ZIP `616a35764f933280563a147dfa52a37e04cfeed45ee27365a649453a2bd1b18f`.
Independent Ubuntu Python 3.12.3 execution passed all 106 offline tests, with
zero skips and all 89 staged inputs unchanged. Its original metadata wrongly
flagged a skip because a passing test's name contains `never_skipped`; the
independent review checks the actual 106 status lines and final unittest summary.
An initial review also incorrectly expected empty stdout; the sole output is the
production Dockerfile hash, now checked against the staged file. Both initial
assumptions are preserved. The nine-member evidence archive is
`7d7345168fd452daef29658573e3d1c3530ca3c8e95a3603dccba3f18d214c85`,
under `ubuntu-runtime-packaging-root-tests-v1/`. No recipe build or gate adoption
is claimed. The proposal preserves the tested curl patch, including its duplicate
Build-Depends entry; its intended static-development dependency change was not
implemented by that original patch. A clean, unresumed curl build remains required.

Two further browser rehearsal failures are retained: v3 used an exact text
locator on a footer containing extra text (archive `481b45420b29774033232c49111c244fd5866700623a646273775a06eaa2496d`,
53 members); v4 completed a real task while all pages were closed and displayed
the exact reply after reopen, then incorrectly expected reload to retain the chat
view (archive `76f7f9d4b908f8704773cb275f51f037dee3a6057ea68370d7599e4086372399`,
51 members). Screenshots were inspected; both snapshots and complete cleanup
were independently verified. The driver now opens the saved conversation after
reload. A fresh v5 rehearsal is running, and Claude is independently reviewing the
frozen soak proposal. These corrections do not convert any failed attempt into
soak acceptance.

## AMD64 toolchain inputs and integrated-test staging — September 29, 2026

The official Go 1.26.8 Linux AMD64 archive was downloaded over HTTPS and matches
the retained official metadata: 66,897,291 bytes, SHA256
`d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b`.
All 16,703 extracted entries are recorded in manifest
`89f2d8007dd0058ba6dfa57883f24c187ca031ab232491a6846775839f2a8b0f`.
The Go executable hash is
`d9a2fa19c7ef8b57f420012c21f49f235c46f08a68c12077d9c753dbb6ccdc34`;
the inspected tool executables have AMD64 ELF headers. No Go or AMD64 code ran.

A separate proposal fills only that missing checksum in the frozen portable
runc/Buildx phase controllers. The existing input verifier passes against the
actual extracted tree. Wrong-platform and altered archive/binary declarations
are rejected. Two initial controls stopped early on macOS's `/var` symlink;
corrected controls resolve the path first and verify the precise intended
refusals. Both results remain recorded. Runc still refuses AMD64 for its missing
static-library inputs. Native builder/bootstrap/build/runtime acceptance remains
open, and these phase proposals are not production adoption. Evidence is under
`Claude outputs/runtime-recovery-20260928/amd64-go-inputs-v1/`; its 11-payload
manifest is `52831b7efe078f87babb62c82088faa4affbdf02352e851042f4af5b0b95023f`.

Six superseded diagnostic Hermes images are preserved in a complete Docker image
archive, with all blob hashes, descriptor sizes, image graphs and tags verified:
`superseded-hermes-images-v1/images.tar`, SHA256
`769fc8b7e6eaa26ca0e80a746e9e1dd48aec6fc4d2b2f77ced86804fae97efa4`
(4,647,150,592 bytes). Only those six local images were removed. This operation
persisted every command and both inventories before evaluating postconditions;
all 47 remaining image inspect objects are unchanged. The current Ubuntu runtime,
corrected engine/coordinator and historical source fixtures remain local. Free
space increased from 12.82 GB to 18.30 GB. No global pruning was used.

The current 198-file working-tree snapshot is staged in native directory
`compose-ubuntu-integrated-v1-trjvg2ex`, selecting runtime `19767a18…`, engine
`63004ab1…` and coordinator `0c3efad0…`. Its config-only preflight passes. The real
test has **not started**; its initial free-space requirement is 21 GiB, with the
existing 4 GiB stop floor and complete acceptance assertions retained. SSH to
192.168.1.149 then timed out before a separate build-tree archival process could
start. That failed attempt has a zero-byte archive, copied no source data and
removed no build trees. Connectivity and additional capacity remain prerequisites.

## Portable engine review and runtime preservation — September 29, 2026

The frozen `portable-engine-recipes-v1` handoff is independently verified:
17 payloads, manifest `4bee9793aa112bb2c65023d3cba7e4fed988c769691bef5548868a3fc2db5026`,
ZIP `975952613521b8879979b10392f22c883f4e0d8ac6ca3ab8b5dd2642fa6280d9`.
Root reviewed the native architecture, account, input and manifest guards. The
independent Python 3.12 run passes all 151 tests without skips, including the
retained official Go metadata, upstream Buildx archive and patch, and synthetic
wrong-platform/output cases. All 30 staged input files remain unchanged and the
controller and test process have exited. The 41-file evidence archive and its
40 payloads were read back and verified: SHA256
`e8048552400470f8f1f5bb087ea61dd2dacccd74e1388bf75e7aa014ddbb5d8d`, under
`Claude outputs/runtime-recovery-20260928/portable-engine-root-evidence-v1/`.
These are offline controller/recipe checks, not actual Go builds or AMD64
execution. The retained ARM64 artifacts keep their original recipe provenance;
the portable proposal's native builds and missing AMD64 inputs remain pending.

The complete tested Ubuntu runtime image `19767a18…` also has a recoverable Docker
image archive on the shared drive. Every OCI blob hash and descriptor size, the
referenced graph and tag were verified. Archive SHA256:
`fd221cc5650177fbad2a752249d66964c0a869f8a1f0ed60b9dfefea24f40366` (2,824,251,904 bytes).
Sixteen exact, unused BuildKit cache records from that completed build were
reclaimed in child-before-parent order; the initial four-parent attempt reclaimed
nothing. This used Docker's explicit ID filters, not global pruning. Free space
rose from about 8.6 GB to 12.8 GB, still insufficient for full Compose acceptance.

The cleanup controller's full image-metadata comparison failed after reclamation;
it did not persist the compared objects, so the differing field is unknown. This
is recorded as an incomplete postcheck, not a passing check. Independent follow-up
retains all 53 previously listed image IDs, and the tested runtime's complete
inspect object equals its pre-cleanup backup. A fresh read-only, network-none,
non-root container imports the three provider features and Tcl/Tk and reads CUA
0.28.2 and contract 6 successfully. Full pre/post metadata equality for all images
is not claimed. Details are in `runtime-cache-reclaim-v2-review.json` and
`runtime-cache-readback-v1.stdout` in the same recovery directory. Future cleanup
controllers must persist each observation and operation before postconditions.

## Startup audit v2 and actual image probes — September 29, 2026

Claude's frozen source audit v2 is received and independently verified: 16 files,
manifest `1baef30d0f01ab073d4d35594dcff641901d4306ff2bb441217f87049b594aee`,
ZIP `fc8544bfebac58d906f85aee3d8edd424ab4e3e130b36d72c9cd51a15160c20a`.
Root reviewed the revised probe's required-phase/interceptor handling and its
negative tests. A failed, timed-out or skipped required phase now produces
incomplete coverage instead of the v1 false pass. The static audit corrects v1:
the model-picker prewarm imports Vertex during managed startup. Its exact
dependencies are already supplied by `[all]`; the production Dockerfile now
checks Vertex alongside Bedrock and Anthropic. All 23 runtime-contract tests
pass. No provider dispatch, reasoning loop or installed dependency was changed.

The exact v2 probe runs against complete Ubuntu image `19767a18…` for both a
custom OpenAI-compatible profile and a native Anthropic profile, each in a fresh
network-none container with a read-only root, UID 10001, dropped capabilities,
no-new-privileges and no host mounts. Both pass all five required phases:
managed entry, gateway import, picker prewarm, agent construction and granted
tool definitions. All five interceptors install, both profiles expose the 16
granted tool definitions, and no missing feature or installer attempt is recorded.
The probe deliberately omits the gateway stdin loop, its other background
services and first-use optional tool installers. The separate real gateway and
desktop fixtures below cover their stated behaviors; this is not a universal
claim that tools never download dependencies.

The initial independent synthetic-test invocation supplied the native export's
manifest instead of the exact handoff JSON and was rejected by the hash guard.
The 6,027 file-to-hash mappings are identical; the corrected invocation uses the
reviewed handoff bytes without modifying the guard or source. Both actual image
probes already passed in that initial invocation. Synthetic-test results are
retained separately from those image results.

The corrected independent Python 3.12 run passes all 38 tests without skips:
13 lazy-install checks, 14 probe-harness tests and 11 packaging-guard tests.
Both native controllers and all helper containers are gone. The 82-file archive
and all 81 manifest payloads are verified:
`14f5a5dd800d3a26610d39e065a8a0c5db2e03774a3281b06c494097a71e4f0d`, under
`Claude outputs/runtime-recovery-20260928/startup-audit-v2-native-evidence-v1/`.

## Complete Ubuntu Hermes candidate — September 29, 2026

The browser/Python/Node base below now has a complete diagnostic runtime:
`sha256:19767a183a718f2758b43bf510d1dafcbf34a92837a4f35e912c68b0e70673a5`.
It builds pinned Hermes with the current security overrides, both provider SDK
extras, agent-browser, Camofox, CUA driver 0.28.2 and the unchanged managed policy.
All original base layers are retained. The image uses the production Dockerfile's
installation tail, with the separately verified Ubuntu candidate as its base;
this is not yet a portable production Dockerfile or published image.

The strict frozen-database whole-image scan reports zero HIGH/CRITICAL
vulnerabilities and secrets, with 329 Ubuntu, 332 Node, 110 Python and 13 Go
packages detected. Report SHA256:
`99ba1b7c59549433e401fa02bfe63bab138ed49dff789b7b23ba36f1aefc4f02`.
The supplemental Debian component scan remains necessary. A fresh non-root
check binds this complete image's 48 browser/JPEG files and two links to the
authenticated package archives; all earlier 291 OS versions still match.
An offline, read-only Anthropic construction probe succeeds as UID 10001 with
zero installer attempts and both provider features present.

The production private-desktop fixture passes with two actual agent containers:
real browser navigation and snapshots, CUA screenshots, coordinate and
accessibility clicks with page readback, snapshot-bound token forwarding,
stale-token refusal and typing with value readback. Private files, credentials
and desktop windows are separate, the designated files remain shared, and the
host sentinel and Docker socket are absent. Desktop restart and revocation
pass. The final screenshot was visually inspected. The driver's own action
result says its effect is unverifiable; the fixture independently verifies the
page contents, so success does not rely solely on that result flag.

The real Hermes gateway/coordinator fixture also passes against its local
scripted provider: tool execution, clarification, authenticated MCP dispatch,
disallowed terminal rejection, fresh-session context and actual approval/denial
round trips. These tests establish transport and tool behavior, not model
reasoning. All 198 staged source hashes are unchanged, the original build,
scan and fixture processes are absent, and no outer containers remain.

The 268-file archive and all 267 manifest payloads were read back and verified:
`d7ad228fc9a7ae9eb7e3c2e3b64641806881081e6349e9480b3cb515212cf082`, under
`Claude outputs/runtime-recovery-20260928/ubuntu26-full-hermes-evidence-v1/`.
It includes the exact staged sources, failed scanner experiments and evidence.
Production source integration and origin-aware release gates, complete Compose
with the corrected engine, native Mac/Windows/AMD64 checks, fresh final-image
scans, final-image soak and publication remain open.

## Chromium and Node on the Ubuntu candidate — September 29, 2026

Signed Debian APT metadata authenticates Chromium and chromium-common
`154.0.8037.57-1~deb13u1` and libjpeg62-turbo `1:2.1.5-4` for ARM64. Their exact
packages were added to the Ubuntu/Python candidate; all other new dependencies
come from Ubuntu's signed repositories. No Debian repository was added to the
Ubuntu image. The old 291 OS package versions remain unchanged. The three
Debian packages' 48 installed regular files and two links match their archives;
five documentation files are omitted by the inherited, unchanged Ubuntu dpkg
policy, and all three copyright files remain. Eight Chromium ELF files have no
unresolved library dependencies. An independent reviewer initially misread the
probe's escaped ELF magic; that correction attempt failed its precondition and
changed nothing. The original probe used the correct four bytes.

Official Node 24.21.0 and npm 11.20.0, including the Node license, were added to
that image. Raw index and native manifest hashes were verified. The resulting
image is `sha256:b713905eae0bd226f523cb1ede69d39195b3637598f06f65703a3f243b6b8794`.
The strict frozen-database whole-image scan reports zero HIGH/CRITICAL
vulnerability or secret findings over 329 Ubuntu packages, 144 Node packages,
one Python package and 13 Go packages. Report SHA256:
`dd3ad5b62b53422b26a9c3203105b099674e0bc25e6c359ed9b9115b7f6d9661`.
This Ubuntu classification is insufficient for the three Debian-origin packages.
A separate inventory built from the authenticated Debian archives and official
Debian OS metadata detects exactly those three packages with Debian PURLs and
also reports zero HIGH/CRITICAL findings. Its report hash is
`b4536a831cf44397fa48379d77cfec67809a8b31b14b283bf57fadb3251dcd1e`.
The inventory is explicitly a supplemental component scan, not the Ubuntu
image's OS identity. Production adoption must enforce both forms of coverage.

A headed Chromium fixture runs as UID 10001 with a read-only root, no networking,
no host mounts, no capabilities, no-new-privileges and the default Docker seccomp
filter. Under Xvfb/Openbox, actual CDP typing and mouse input confirm
`BROWSER_INPUT_OK_729`; canvas JPEG encode/decode reproduces the test pixel.
The screenshot was retrieved and visually inspected. Chromium's own
`--no-sandbox` flag is inside the Docker boundary. This establishes headed
browser compatibility, not the CUA driver or a full Hermes run.

The first fixture reached its result file but `docker cp` could not collect the
live tmpfs evidence; its result was not retained and is not counted as a pass.
The unchanged fixture then passed with collection via `docker exec tar`.
Both original fixture containers and the known browser build/scan processes are
gone. The 114-file archive and all 113 manifest payloads were read back and
verified: `eccb79b887aceaacc34d09b396bd76c2beb5dc4c959ce309fe9d26ba95e96b56`,
under `Claude outputs/runtime-recovery-20260928/ubuntu26-browser-evidence-v1/`.
Large authenticated package inputs remain on the runner with hashes in that
archive. Full Hermes integration, final source packaging, native platforms,
fresh final-image scans, complete acceptance and final-image soak remain open.

## Python 3.12 on the Ubuntu candidate — September 29, 2026

The official Python 3.12.14 index and its ARM64 manifest were fetched and their
raw hashes verified. The ARM64 manifest is
`sha256:950206c37262dd86c55659797f6ee418fee30535072f65a82ed470d985f5cda5`.
A separate native candidate copies that image's `/usr/local` Python prefix onto
the Ubuntu curl candidate below, runs `ldconfig` and `pip check`, and leaves the
Ubuntu OS packages intact. The resulting image is
`sha256:f25d80c41af66895322b7f9dd0499b97e5600465b2305347aa2507e154521453`.

As UID 10001 with a read-only root and no networking, all 78 shipped native
extensions import successfully and their `ldd` results contain no unresolved
libraries. Actual bz2/lzma/zlib round trips, an in-memory SQLite query and Tcl
initialization pass. This does not exercise a Tk window or an agent desktop.
The strict frozen-database scan reports no HIGH/CRITICAL vulnerabilities or
secrets; its reported coverage is 291 Ubuntu packages, one Python package and
13 Go packages. This coverage is not a separate CPython source-security audit.
The scan report hash is
`48e4eeeecaa3cdcc776169ef9dbd924b5fc3e9dcda47b9217abedf692a78a665`.

Both original processes and all helper containers are gone. The 17-file
evidence archive and its 16 manifest payloads were read back and verified:
`d502a49ed2ffd92fde5978058b0f2b5faf67df51a8f60a880764bb2d31351bc1`, retained under
`Claude outputs/runtime-recovery-20260928/ubuntu26-python312-evidence-v1/`.
This establishes a Python/base compatibility candidate. Chromium, Node/npm,
Hermes, browser addons, CUA driver, production source integration, full image
security/runtime acceptance, native platforms and final-image soak remain open.

## Ubuntu curl HTTP/3 candidate — September 29, 2026

The native ARM64 curl candidate now builds and passes the distribution's
OpenSSL and GnuTLS `test-nonflaky` targets: 1,775/1,775 and 1,772/1,772 reported
OK respectively. The upstream target's existing skips and flaky-test handling
are retained; this is not a claim that every upstream test ran. Source review
confirms only `debian/rules`, `debian/control` and `debian/changelog` differ from
the authenticated Ubuntu source package. All distribution patches are unchanged.
The derived version is `8.18.0-1ubuntu2.7+openharness.http3.1`.

The initial test container's 512-process limit caused `pthread_create` failures
in tests 3026 and 3207. That failed run and its 17,143-file working tree remain
unchanged. A copied tree reran the unchanged test targets with a 2,048-process
limit, peaking at 646 processes with zero limit/OOM events, and completed binary
packaging. Network isolation, UID 10001, dropped capabilities, memory/CPU limits
and no-host-mount execution were retained. No production-agent limit changed.

The OS-only image is
`sha256:51f372b99d980f5038baed90a65a1dee95db8b50f6d2fffa64d03731d5a4cc13`.
Compared with the preceding Ubuntu probe, it adds only libnghttp3 1.12.0 and
replaces the three curl runtime packages with the reviewed builds. No other OS
package versions change. Its actual curl protocol and feature sets match the
retained Debian runtime baseline, including HTTP/3. Sixteen installed regular
files and three symlinks match the built packages as a non-root reader. Four
documentation files are omitted by the unchanged official Ubuntu dpkg policy;
copyright and changelog files remain present. An initial review incorrectly
expected those excluded documentation files and is preserved separately.

A separate fixture image adds the signed Ubuntu aioquic test-server package.
Every pre-existing OS package version and the curl file hashes remain identical.
With no external networking, no capabilities, a read-only root and UID 10001,
the real curl client transfers 262,144 verified bytes over HTTP/3 with successful
certificate verification. The same server with its certificate untrusted yields
curl exit 60, no response body and no HTTP request observed by the server.

The strict frozen-database scan reports zero HIGH/CRITICAL vulnerability or
secret findings over 291 Ubuntu packages and 13 Go packages; report SHA256 is
`ccf415e44d792e3ec9d523db34f0ea43025dbaccf8d7d80cd877a5a2cf3e8a32`.
This does not mean every severity is clear: the separate upstream-advisory review
records two potentially applicable low/medium issues without matching Ubuntu
patch names. No finding exclusions were added. An initial assembly helper used
an invalid bare-image-ID `FROM`, so BuildKit attempted a nonexistent registry
repository; the corrected helper uses an existing local tag and verifies its
exact image ID before and after assembly. No publication-access workaround was
used. All original build/review processes and named helper containers are gone.

The 119-file evidence archive and all 118 manifest payloads are verified:
`a213a3ac65241144295a32c9abb058fcb388bc69b89f31cb792e522c0fd5b128`, retained under
`Claude outputs/runtime-recovery-20260928/ubuntu26-curl-http3-evidence-v1/`.
The compiler working trees and all package outputs also remain on the Ubuntu
runner. This candidate is not yet a complete Hermes runtime or a release.

## Anthropic startup and Ubuntu runtime inputs — September 29, 2026

The startup audit found a second lazy SDK installation path. Anthropic profiles,
including custom endpoints ending in `/anthropic`, construct a client that ensures
`anthropic==0.87.0`. The production Dockerfile now installs
`.[all,bedrock,anthropic]`, runs `pip check`, and asserts both SDK features are
present. The constraints add Anthropic 0.87.0 and docstring-parser 0.18.0. The
23 runtime-contract tests pass locally on Node 24.19.0. No Hermes reasoning,
tool-policy, authentication or credential-storage behavior changed.

The native ARM64 diagnostic candidate is
`sha256:ea33e893371d89efd2f3ba0a55cce1defdfcd3fd944f21e6aeaaec7c0ff7c8fa`.
It adds exactly those two packages, changes/removes none, and retains the base
image layers and runtime configuration. In fresh, non-root, network-disabled
containers, the earlier Bedrock-only image attempts an Anthropic installation
and fails client construction; the candidate constructs and closes the actual
SDK client with no installer calls. This proves client setup, not an inference
request or the complete gateway. Its strict scan still fails with the same
94 HIGH and one CRITICAL vulnerability rows, with no new rows or HIGH/CRITICAL
secret findings. The complete production source rebuild remains required.

An official Ubuntu 26.04 ARM64 OS-only probe installs the original runtime and
desktop OS dependencies plus prospective Python 3.12 shared-library inputs.
Its image, `sha256:509c69da01117b929982a15ed3b168074e7b8d62b33d4cbaf66e0009c2b68286`,
has zero HIGH/CRITICAL vulnerability or secret findings in the same frozen
Trivy database, covering 290 Ubuntu packages and 13 Go packages. Actual curl
output retains all baseline protocols; HTTP/3 is its sole missing feature.
This is not a complete Hermes image: Python 3.12 and Chromium packaging, full
runtime behavior and final security coverage are still outstanding.

Signed Ubuntu source indexes authenticate curl `8.18.0-1ubuntu2.7` and all four
source inputs. A separate dependency builder completed successfully as
`sha256:ae379b00685e72b4f155aaf35336b39fdc89438ba47cf26c65cc472544ccbff2`.
A non-root, network-disabled candidate build tested a minimal packaging
change: enable nghttp3/OpenSSL QUIC for the OpenSSL flavour, retain GnuTLS and
both distribution test targets, and record the derived package version. Its
completed build, transport and scan evidence appears above. No full Ubuntu
replacement has been adopted; complete image acceptance remains required.

The SDK, Ubuntu OS and signed-source evidence archive has 72 files and 71 verified
manifest payloads: `730412e95be49c9a150a5279929dd634df9708efbe7643e28f3fa5bea4df689b`.
It is retained in `Claude outputs/runtime-recovery-20260928/startup-sdk-ubuntu26-evidence-v1/`.
The subsequent curl builder/build are tracked separately under
`ubuntu26-input-review-v1/`. Claude's v1 startup audit was received and its
Anthropic finding independently confirmed; its proposed probe can falsely pass
when a required phase fails before an install check, so it is not accepted as a
success verifier. A v2 correction and full-source audit are still running.
Native Mac/Windows/AMD64 acceptance, final-image soak and publication remain open.

## Per-architecture engine provenance and readable notices — September 29, 2026

The unreleased engine inputs lock is now schema 2. Each architecture owns its
component versions and source manifests. Known manifest hashes must match the
exact manifest files listed in that architecture's inputs; incomplete metadata
is explicitly null. The validator rejects the old shared schema, swapped
manifests, missing manifest files and mismatched image labels. Staging derives
component build arguments and an architecture-specific notice from the same
entry. All 108 retained ARM64 input hashes and their original component versions
and manifests are unchanged. AMD64 remains incomplete; no ARM64 record is used
as its build evidence. Both registry-input publication gates remain closed.

An actual native ARM64 build exposed an older notice-directory defect: Docker's
`COPY --chmod=0644` created the destination directory with mode 0644, preventing
non-root access to the notice. The Dockerfile now creates that directory as 0755
before copying the 0644 file. Real non-root controls retain the old failure and
verify the new directory/file modes and readability. No agent isolation,
authentication or credential-storage behavior changed.

The corrected candidate is
`sha256:63004ab1782ee488ab8547b801c1beb186f86925d566cc8fd25f5d12609c020e`.
All 107 installed component files and the generated notice match their expected
hashes as UID/GID 10001. The 16 official base layers and runtime configuration
are unchanged. Rebuilt layers after the base differ; an initial review assumption
that all earlier layer digests would be identical was false and is retained in
the failure evidence. File hashes, original base identity and the scan are the
actual evidence, not that rejected assumption. An earlier post-build helper also
failed while parsing the two-segment APK path; it did not invalidate the build
or trigger a duplicate build. The subsequent rebuild was for the real directory
permission fix.

The same strict Trivy 0.74.0/database scan reports zero HIGH, CRITICAL or
HIGH/CRITICAL secret findings, covering 53 Alpine packages and nine Go
binaries, including Buildx. The binaries match their previously reviewed
source/SBOM supplements. This is local ARM64 assembly from unpublished inputs;
full Compose acceptance has not yet been rerun on this new image.

A fresh 198-file snapshot passes 36 tests, full typecheck and scoped lint on
Node 22.23.3. Two PowerShell launcher tests skip because PowerShell is absent;
all release-packaging tests, including Docker Compose configuration, pass.
An earlier typecheck caught a missing map annotation, fixed before these final
checks. All 198 source hashes remained unchanged. Independent terminal checks
confirm original build/review processes and helper containers are absent.

The 32-file native evidence archive and all 31 manifest payloads are verified:
`eb43cd826bf42808113aec4c15019fbdd4c15341336ec17723099fe1160c6930`.
It and the local source snapshots, failure logs and review scripts are retained
under `Claude outputs/runtime-recovery-20260928/engine-architecture-lock-v2/`.
Hermes security remediation, its full source rebuild, native AMD64/Mac/Windows
acceptance, final-image soak and publication remain required.

## Startup dependency and combined image acceptance — September 29, 2026

The newly integrated engine and coordinator initially exposed an intermittent
Hermes startup failure. The first run timed out without retaining its unfinished
snapshot. The fixture now retains that snapshot on timeout without changing its
deadline or assertions. A second run completed the main agent's work, then timed
out starting the peer. Read-only process evidence caught
`python -m pip install boto3==1.42.89` during that peer's model setup. Both failures,
unchanged source manifests, original process exits and exact cleanup are retained
in archives `cb407b5c…` (45 files) and `709fb732…` (50 files), independently verified.

The installed pinned Hermes source explains the dependency path:
`agent/agent_init.py` imports `agent.bedrock_adapter` in ordinary OpenAI-compatible
client setup. That module immediately ensures its optional Bedrock SDK, but the
upstream `all` extra excludes it. The production Dockerfile now selects
`.[all,bedrock]`. Constraints pin boto3 1.42.89, botocore 1.42.97, jmespath 1.1.0 and
s3transfer 0.16.1 to the verified candidate's versions. No reasoning-loop or tool
policy change was made. The 23 runtime-contract tests pass locally on Node 24.

A diagnostic native ARM64 Hermes image,
`sha256:4658234040babcf92fbb19d30c93dd107103a844249399c3ae575c460dc8b95d`,
adds exactly those four packages to the retained image. Package inventories prove
no removals or changes to existing packages; all original layers and runtime
configuration are preserved. In separate read-only, network-disabled containers,
an installer interception probe reproduces the baseline's missing SDK and install
attempt, while the candidate imports the same adapter without any installer call.
The original real peer process, upstream source, negative control and candidate
result together establish the packaging defect. A complete production Dockerfile
rebuild remains required; this derived-image check is not that rebuild.

With engine `e67047ed…`, coordinator `0c3efad0…` and this Hermes candidate, the full
Compose fixture passed in 166.7 seconds. It exercised actual Hermes tools through
a scripted local provider, pairing/authentication, selected-folder limits, two
private desktops, actual click/type input, shared files, restart persistence and
stopped backup into an empty project. All 358 backup entries matched after restore,
including file bytes, owners and modes, and restored desktop input passed. The
entry count is lower than the earlier 6,873-entry backup because SDK files are now
in the image: comparison identifies 6,316 removed SDK paths. Independent review
also recomputed private/shared/memory/skill proof hashes. Its initial arbitrary
1,000-entry floor was replaced by those content checks; the fixture's exact
before/after manifest equality was unchanged.

Independent terminal review verified six actual outer container identities,
Buildx/runc bytes in both projects, all 198 staged source hashes, original process
exit and removal of the exact containers, volumes and networks. Minimum sampled
free space was 6,080,851,968 bytes, above the unchanged 4 GiB floor. The screenshot
was inspected. The 40-file safe evidence archive and all 39 payloads were read
back and verified:
`2a2fd802f8774e2b29d37cf7a0bd3b1096f07ec4b6edcac29d0bd872ad156604`.

The strict candidate scan uses the same Trivy 0.74.0/database as the baseline.
Its vulnerability rows are identical: 94 HIGH, one CRITICAL and zero HIGH/CRITICAL
secret findings, covering 318 Debian, 332 Node and 108 Python packages. The
startup fix adds no findings but does not pass the security gate. The 21-file
build/import/package/scan evidence archive has 20 independently verified payloads:
`af18177bb08d9a8f8c30b41eb61eac219762b99541478d69332decec1ec9417f`.
Artifacts remain under `Claude outputs/runtime-recovery-20260928/`.

Capacity was recovered by exporting and verifying five completed intermediate
images to the shared drive before removing only their exact local tags. Their
complete OCI blob graphs and Docker load metadata are retained under
`retired-native-images-v1/`; all other image IDs remained unchanged. Current and
historical-upgrade images were retained. No global prune or reduced disk floor was
used. All native workloads for these checks are now terminal.

Claude's source-only portable recipe handoff is received with all 17 payloads and
ZIP verified, but its code/tests have not yet been independently accepted. Claude
is auditing other startup imports. Full source rebuild, Hermes security
remediation, architecture-specific engine inputs, native Mac/Windows/AMD64
acceptance, final-image soak and publication remain open. No physical-host
acceptance handoff has arrived.

## Engine release source integration — September 29, 2026

The production release workflow now builds and gates a derived engine alongside
Hermes and the coordinator. The engine checks an exact file and mode manifest
before installing the signed Expat APK and reviewed containerd, runc and Buildx
inputs offline. The coordinator verifies the replacement Buildx checksum before
executing it; capture validates both input identity and checksum labels. Incomplete
architecture locks still prevent publication. ARM64 now records all 108 input
hashes, including the signed Expat APK, but its registry digest is missing; AMD64
inputs and native acceptance remain incomplete.

A fresh 198-file source snapshot produced native ARM64 engine
`sha256:e67047ed7f1bc5c7df32ee09a9897b0d02479b19ca171174a63c052c22b80195`
and coordinator
`sha256:0c3efad0e0ce66ff5ee2e572d767efc1e78e15852e886b5860eee4080a6889d6`.
The inputs image is local and unpublished. Actual builds rejected a tampered engine
input and an incorrect coordinator Buildx checksum. The exact Expat-version check
failed on the official base and passed on the derived engine. Non-root container
reads verified all 107 shipped engine files and all 23 coordinator replacement
files byte for byte. Source checks passed all 29 scoped tests, full typecheck and
scoped lint; all 198 source hashes remained unchanged. A local shared-folder
TypeScript run encountered an unreadable duplicate filename; the complete clean
native snapshot passed. No claim is made that the earlier full browser suite ran
again for this integration.

Both complete image scans returned zero HIGH/CRITICAL vulnerabilities and zero
HIGH/CRITICAL secrets with Trivy 0.74.0 and unchanged database `da3d95ca…`, without
exclusions. Engine inventory covers 53 Alpine packages and the engine Go binaries;
coordinator inventory covers 26 Alpine and 205 Node packages, Docker CLI and
Buildx. The Docker CLI is represented by its standard-library record, and
unversioned Buildx/runc main modules retain the limitations and same-byte source
supplement documented earlier. The scans are evidence within that coverage.

The 93-file evidence archive was read back and all 92 payload hashes verified:
`a46256f0177989a1fd91526e8eb45f76f54301ecc4afaa7ab77d1e2ef76c5687`.
It and `engine-release-integration-root-v1-review.json` are retained under
`Claude outputs/runtime-recovery-20260928/`. All six original native processes
were absent and no Docker containers remained. Full Compose acceptance on this
new pair is pending capacity; earlier image acceptance does not carry over.

A separate Ubuntu 24.04 Hermes OS probe installed 291 packages and passed the same
strict scan and non-root Python/native-library probes. It includes neither the
full Hermes application nor Chromium. Its curl loses `ipfs`, `ipns`, `ws`, `wss`
and HTTP3 compared with the current image, so it is not a feature-preserving
replacement and was not adopted. The exact baseline output and capability
comparison are retained separately. The existing Hermes image still has 94 HIGH
and one CRITICAL finding. Full Hermes remediation, native Mac/Windows/AMD64
acceptance, final-image soak and publication remain open.

## Coordinator source integration — September 29, 2026

The production Dockerfile now uses the verified Alpine runtime stage, pinned to
Node's multiarch index
`ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`.
Its ARM64 and AMD64 manifests match the independently inspected official inputs.
All 12 added APK versions are explicit; npm 11.20.0 is copied from the existing
integrity-checked build stage. GNU ps is retained for process identity. The
application builder still uses its pinned Debian Node image.

A fresh 193-file current-source snapshot built native ARM64 image
`sha256:e48097bef07a690d3525906fefc8ad15cb842f40b3e8ef18885fcc3baf6c8521`.
All 26 installed Alpine packages match the accepted candidate. Normal-user SQLite
and process identity checks passed. The rebuilt frontend's new assets/build IDs
and two directory-mode changes are recorded in the payload comparison; runtime
file contents are unchanged. This image still carries upstream Buildx from the
existing CLI stage. The complete strict scan therefore reports exactly its three
known HIGH findings, zero CRITICAL and zero HIGH/CRITICAL secret findings; the
release gate still fails. Integrating the previously verified replacement into
the portable source/release pipeline remains required.

Private `Claude outputs` artifacts are now excluded from both Docker context and
source packages. A synthetic file was placed in that directory in the isolated
build context. Inspection of the actual, never-started builder image confirmed
the directory absent and the current Dockerfile present. Source-archive tests
also verify exclusion of a committed synthetic audit file.

The full Node suite initially exposed an incorrect test-fixture assumption:
creating a file with mode 0644 under umask 077 actually produced 0600. An isolated
reproduction confirmed the runtime correctly accepted the private file and
rejected an explicit 0644 file. The fixture now chmods and verifies its intended
insecure mode. Its five tests pass on macOS Node 24 under umask 077. A fresh native
Ubuntu Node 22.23.3 snapshot then passed 216 Node tests with three platform/tooling
skips, typecheck, lint (zero errors, five existing upgrade-fixture warnings), and
the production build. All 193 source hashes remained unchanged during checks.

The same source snapshot passed 120 mocked browser cases: 60 desktop and 60
mobile, with no skips, unexpected results or retries. Independent review checked
every result, original process exit, absence of owned browser/server processes,
released loopback ports, and unchanged source hashes. This verifies the browser
UI with a mocked coordinator on Ubuntu ARM64, not paid inference or other host
platforms.

All 12 pinned x86-64 APK inputs were also acquired and signature-verified, with
their package architectures checked as x86_64/noarch. The initial cross-architecture
attempt correctly failed with the ARM64 image's trust keys. The second used public
keys extracted from the pinned official AMD64 image in a never-started container;
no host trust store changed and no AMD64 executable ran. This establishes input
availability only, not AMD64 runtime acceptance.

The 80-file evidence archive was downloaded and all 79 payload hashes verified:
`78f9185cc5f2f0376e317ac14b867174f2ea0cf6c1fcf15c7ffc18f59d51ff7d`.
It is retained under `Claude outputs/runtime-recovery-20260928/` with the original
failure evidence. Patched-engine/Buildx source integration, Hermes security fixes,
native Mac/Windows/AMD64 acceptance, final-image soak and publication remain open.

## Alpine coordinator candidate — September 29, 2026

A separate native Linux ARM64 candidate replaces the coordinator's Debian runtime
with official Node 24.21.0 on Alpine 3.24.2. Its base manifest is
`38a36422dc7de80f3ced964270f23b3b17f73af816728d21a5fbbf84bf8be46f`.
Twelve APK inputs, including procps-ng and CA certificates, passed Alpine signature
verification before an offline build. GNU ps is necessary: the initial BusyBox
probe rejected the process-recovery arguments `ps -p PID -o lstart=`.

Candidate image
`sha256:4f51b67d4d7504e87959e8e8671edc2b4115f91730a4ce6dbd62e065d94d9bf5`
retains npm 11.20.0, the Docker CLI, patched Buildx, and all 3,080 application
entries from coordinator `c09331a9…`, with exact bytes, modes, owners and links.
Normal-user, read-only container checks passed SQLite and process identity.
Claude's replacement Node health probe matched curl in five real Node 24 cases:
200, 503, 404, redirect, and refused connection. A separate Docker health-state
test confirmed healthy output and transition to unhealthy after 20 failed probes,
with the existing interval, timeout, retry and start-period settings.

The full image scan using Trivy 0.74.0 and unchanged database `da3d95ca…` returned
zero HIGH/CRITICAL vulnerabilities and zero HIGH/CRITICAL secret findings, exit 0,
without exclusions. Inventory includes 26 Alpine packages, 205 Node packages,
209 Buildx records and one Docker CLI standard-library record. The unversioned
Buildx root is bound by its unchanged binary hash to the earlier explicit
source-version supplement. These are the scanner's coverage limits, not a claim
that unknown vulnerabilities are absent. The 60-file candidate evidence archive
was downloaded and all 59 payload hashes verified:
`ee55b775b7afbd3c843a8077c90b63cc7d0ab81d2c3d2d4646eb7e3cc462f25d`.

The first full Compose run stopped at its unchanged 4 GiB free-space floor during
restore. Its stopped backup, failure evidence and exact cleanup are preserved;
it is not a passing acceptance run. Only unused Buildx module/build caches were
removed to recover 2.6 GB, after confirming no phase process or container remained
and retaining source/vendor, binary and evidence hashes. Failure archive SHA256:
`3ed85549addbed49d53500f68bc240f1fd1cb79194975c9554becd51b3a9908a`.

A fresh run of the same candidate then passed in 169.5 seconds, with a minimum
6,306,750,464 bytes free. Real Hermes tools, pairing, credential rotation, explicit
folder grants, two private desktops, shared files, coordinator restart and stopped
backup/empty restore passed. All 6,873 restored entries matched, and real desktop
input worked after restore. Independent review bound all six outer container IDs
and observed the actual engine/coordinator Buildx binaries. All 189 staged source
hashes and modes remained unchanged; the only change from the frozen source was
the recorded Node healthcheck. Original processes and both projects' containers,
volumes and networks were absent. The 41-file safe evidence archive was downloaded,
all 40 payload hashes verified, and the desktop screenshot inspected:
`1acf33d84251a9c25cd72d6afbecdc23111e0b0c2cedad7e18995c9f0ed2452f`.

The healthcheck and coordinator-only curl removal are applied to the shared
source. Four affected contract/packaging test files passed 35 tests with one skip;
`git diff --check` passed. The Alpine runtime itself remains a candidate: its
portable production-source integration and rebuild are still required. Hermes is
unchanged and still has the separately recorded 94 HIGH/1 CRITICAL findings.
Native Mac/Windows/AMD64 acceptance, final-image 24-hour soak, derived-engine
release integration and publication remain incomplete. All artifacts above are
under `Claude outputs/runtime-recovery-20260928/`.

## Buildx remediation and complete engine scan — September 28–29, 2026

Claude prepared a separate Buildx source recipe; all 23 delivered files and the
ZIP were independently hash-verified. Root's 71 offline checks passed without
skips. A native restricted builder then completed real checksum-database-backed
dependency preparation and a separate network-disabled compile using official
Go 1.26.8, CGO disabled and an empty module cache.

The reviewed source manifest is
`bab79bcde6b007825e81cce6e7acb1ef0727406e723289d53bf07cf86345955e`.
All 9,059 source/vendor entries and the complete exported archive were checked.
The sole legacy Docker names-generator import became a byte-identical attributed
internal helper; `go-archive` changed from 0.2.0 to 0.3.0. Tidy made no further
requirement changes. All 64 original Buildx packages remain, plus the helper;
all five drivers remain. The 222 unchanged vendored modules retained their common
file bytes; three upstream YAML lint-configuration files were added by vendoring.

The resulting static ARM64 binary is 61,407,394 bytes, SHA256
`c4c362bc28faa25f2df1e33ca3ba3cd90fff69c943ca78495787fefc04aef49b`.
Independent inspection matched all 207 dependency versions to the reviewed graph,
checked all five driver markers, and confirmed an empty module cache after build.
The compile took 53 seconds. Both phase containers exited successfully and were
removed. Materialization and binary evidence archives under
`Claude outputs/runtime-recovery-20260928/` have SHA256
`66b0884450b79c2f85bf4ebc689e3169f738ca95dee97fd46280d76b45a147e0`
and `f14a4116fd62a5a542b6a97c5236053842e15d60231de2e613107545e7df91fe`.

Separate candidate engine
`sha256:87f075ed70d575a1bedbaa84f0835141e5f6e49ce3ae5c3e01b074ab695d2b74`
retains all 21 base layers and runtime configuration, adds the replacement Buildx
and complete source/licenses/provenance, and changes only candidate labels.
Never-started container inspection verified all 23 shipped files and modes.
Build evidence archive SHA256:
`d11f436cc11ffc8ff5ed5e2cf736857e11bb044b287934517e1b2700e7b850da`.

With the same Trivy 0.74.0 and frozen September 28 database, the baseline again
reported three HIGH findings. The candidate image and standalone binary reported
zero HIGH/CRITICAL vulnerabilities and zero HIGH/CRITICAL secret findings, exit 0,
with no ignore file or suppression. All original executable scan targets remain;
Buildx has 209 detected packages. Locally compiled Buildx and runc main modules
lack version fields in Go build metadata. A separate explicit source-version
CycloneDX supplement checked Buildx 0.37.1 and runc 1.5.2 and also passed with both
components present. It supplements the actual image/dependency scans; it is not
automatically discovered metadata. Scan evidence archive SHA256:
`fcadb6b45337bbf799b8aa2884090a34741713755c6b90625f7668a17d0fd3a7`.

The exact engine then passed the full real Compose fixture in 175 seconds.
All six original/restored outer container IDs and both engines' actual runc and
Buildx versions/hashes were observed. Private desktop input, two-agent isolation,
explicit folder grants, credentials, restart persistence and stopped backup into
an empty restore volume passed; all 6,873 restored entries matched. Independent
terminal inspection confirmed original processes and exact resources absent,
all 189 source hashes/modes unchanged, and the safe 15-file archive readback:
`84d7033ab704ddc1deec5d02da402cd029c2a841d4b194232f6a7dc35b275025`.

This establishes the candidate ARM64 engine security and Compose gates for those
inputs. The separate local Buildx driver check below also passed. Full application image security, native Mac/Windows/AMD64
acceptance, multiarch packaging and publication remain open. No production default
or release image was changed.

## Buildx local-driver acceptance — September 29, 2026

The exact `87f075ed…` engine and `c4c362bc…` Buildx binary passed real local
`docker` and `docker-container` builds on native Ubuntu ARM64. Each built a
multi-stage FROM-scratch context without network access and exported the same
independently checked file bytes, sizes, paths and modes. The container driver
used official BuildKit v0.32.2 ARM64 manifest
`sha256:5a8cd84cb3fcfd082789a08f92bd36f8e745c6231edd78e24a3bf34fd471a823`;
the versioned/default tag manifests, config and all seven layer digests were
verified before execution. All five Buildx driver packages remain compiled and
registered; cloud, Kubernetes and remote infrastructure execution is unclaimed.

Claude supplied the original source-only harness; root reviewed it and ran all
23 offline tests. The first actual run exposed the official DinD wrapper's
self-mounted `/tmp`: Docker cp saw underlying files while exec saw the empty
tmpfs. A separate read-only diagnostic established that cause. Version 2 moves
only the test context to its unique top-level container directory and adds a
regression modeling the two filesystem views; all 24 offline checks pass.
Both earlier failed attempts and exact cleanup evidence remain preserved.

The fresh v2 run passed in 6.725 seconds. Root reviewed 55 command records,
independently recomputed both output trees, verified the actual BuildKit image,
and checked original processes and exact labelled containers/volumes absent.
No host bind mount or published port was used. Minimum sampled free disk was
18,724,749,312 bytes. The 67-file archive
`Claude outputs/runtime-recovery-20260928/buildx-acceptance-v2-safe-evidence.tar.gz`
is SHA256 `4c2b4a4888c2d79c25a9f90a922bf5a2ccadd83cc6b55ef0107434be5780fd4a`;
all 66 payloads were independently verified. This does not clear application
image security, other-platform acceptance or the remaining release gates.

## Refreshed application image scans — September 28–29, 2026

Fresh scans of the frozen application images against the same database confirm
54 HIGH/0 CRITICAL findings in coordinator `cd1085b1…` and 94 HIGH/1 CRITICAL in
Hermes `d81b01ed…`; both exit 1, with zero HIGH/CRITICAL secret findings. The
remaining critical finding is the database's libxml2 CVE-2026-6653 finding.
All reports, package coverage and commands are retained in
`Claude outputs/runtime-recovery-20260928/application-image-scans-v1-evidence.tar.gz`,
SHA256 `0b73b70f9069b2dc093c257623a903c6aa38efbff07741e1958ad1352795ad79`.

The coordinator also bundled the old Buildx. A separate candidate
`sha256:c09331a9832889e9de26d411d28123be832b7fede03bab41f342a5b4ec62c6a2`
copies the same verified replacement and complete provenance onto the unchanged
coordinator base. Its base layers and runtime configuration remain intact; all
23 added/replaced files were inspected in a never-started container. The strict
scan falls from 54 to 51 HIGH findings, with exactly the three expected Buildx
findings removed and nothing added. All 51 Debian findings remain, so this gate
still fails. Candidate build/scan evidence archive hashes are
`42dfb2ad6ebb189b038b3d7adfb1dc4428e6abecec7a578b1beac65364f35ca4`
and `011d5517ea01fea8960a37ef3f4806628fd8fb232a8acd051c9b525583db61ce`.
The combined coordinator and engine candidates also passed the full real Compose
fixture in 175 seconds on Ubuntu ARM64. The audit captured all six original and
restored outer container image IDs, both engines' actual Buildx/runc versions, and
the running coordinator plugin's exact SHA256/version. Private desktops and
isolation, shared files, selected-folder permissions, credential rotation,
restart persistence, and the 6,873-entry backup/restore passed. All 189 staged
source hashes/modes remained unchanged; original processes and exact project
resources were independently absent afterwards. The 15-file safe evidence
archive is `compose-buildx-coordinator-v1-safe-evidence.tar.gz`, SHA256
`c61d9aa98f5fe9786dcf6600065cca819b5f119295f41dfce6f532c9e84b0243`;
all 14 payload hashes were verified and the desktop screenshot inspected. This
uses scripted inference and establishes neither other-platform acceptance nor
application security clearance. No application image default was changed.

## Real historical-source upgrade and rollback — September 28, 2026

The ninth fixture attempt passed on native Ubuntu ARM64: 336 seconds, exit 0,
no supervisor abort, followed by independent confirmation that both original
processes and all exact-owned containers, volumes and networks were absent.
All 319 historical/current committed source-file hashes remained unchanged.
The 33 offline fixture checks also passed on macOS Node 24.19.0 and Ubuntu
Node 22.23.3. Safe evidence was copied back and all 36 payload hashes verified:
`Claude outputs/runtime-recovery-20260928/upgrade-fixture-v9-safe-evidence.tar.gz`,
SHA256 `98ef1e984ee594b0879adcd578f7ec6ebd5ee24a02a11ce681bafa13fa29f174`.

This sequence used freshly built, unchanged historical 0.3 source checkpoint
`603b19b917fd9753f52599cf4d93a91728d67c0b`, frozen current source `3a8f534`,
the recorded runtime/coordinator images, and the candidate containerd/runc engine.
Each of the original, upgraded and rollback stages submitted three real browser
jobs through the pinned Hermes runtime and a scripted local provider. The current
stage exercised one-use browser pairing, clarification, the renamed task tool,
actual denial/approval effects, saved-credential adoption and rotation, and exact
state retention across coordinator restart. Original profile revision JSON stayed
byte-identical; only the two explicitly saved current revisions were added.

The stopped original backup contained 3,360 entries. Restoration into each empty
destination matched paths, contents, modes and owners. Migration retained memory,
skills, private/shared files, the task, profiles and all three completed histories.
Rollback restored the untouched original backup, retained exact original state,
excluded the upgraded shared file and successfully ran the original UI/jobs again.
Current private desktops produced a screenshot and verified click/type readback
with two-agent isolation. The screenshot was independently inspected.

The preceding eighth attempt reached stopped backup/empty restore but rejected
Compose's `null` image-default command/entrypoint representation. The corrected
guard accepts only `null` or absent values and still rejects empty/explicit
overrides. Its failed evidence remains preserved (archive SHA256
`57f27a1b4c40e30ff919bdc03a32133911d1ec0039db368b1706dac574c4543d`).

Scope: this is historical-source upgrade acceptance, not an official historical
installer artifact or recovered original build attestation. Original approval
transport defects, task-tool naming and browser-local history limits remain
explicitly recorded below; no original-desktop pass is claimed. Historical nested
Docker stores report a different image index/config identity; source bytes and
the pinned Hermes revision were checked. This does not establish model reasoning,
native Mac/Windows/AMD64 acceptance or release readiness. That tested engine still
had three HIGH findings; the separate Buildx candidate above removes them. Full
application image security gates remain open.

## Historical upgrade fixture recovery — September 28, 2026

Claude's four-file historical upgrade fixture handoff was independently reviewed
against original `cafc0a4655d00bc9bc45269378a92dd357b5e9fe` and candidate
`3a8f5341a7a1e42451b8448de8a50a121e68e7fb`. The original lacks the working
approval/input transport and current task-tool name; the fixture records that
original behavior while requiring the complete interactions after upgrade.
Original completed history and profile revisions must survive unchanged.

The first new live attempt built and started the original production UI, then
failed before browser work because Chromium's singleton Unix-socket path exceeded
the platform limit under the durable scratch directory. Its processes exited and
all exact-owned containers, volumes and networks were independently confirmed
absent. All 323 committed source-file hashes were unchanged. The source files have
Git modes masked by the supervisor's private umask; their original extracted modes
were not separately recorded. Safe failure evidence:
`Claude outputs/runtime-recovery-20260928/upgrade-fixture-v2-safe-failure-evidence.tar.gz`,
SHA256 `8a3faf96600f5e737ecf8e4ae44cbb1ce05971ed6b56d042048362c3db3d9706`.

The revised fixture keeps only browser scratch in a short private temporary
directory and retains launch failures and screenshots in durable evidence.
The same installed Chromium launches successfully with that correction. All 30
offline fixture tests pass on macOS Node 24.19.0 and native Ubuntu Node 22.23.3,
including a new launch-failure diagnostic regression. The Linux runtime workflow
now runs these tests. Two further attempts found fixture configuration defects:
the native historical Docker client rejected a 129-byte control-socket path, and
the original browser still contacted port 4317 instead of the fixture's ephemeral
coordinator. The socket failure was directly reproduced; a separate browser trace
of the unchanged original build established the port mismatch. The fixture now
validates socket path length before execution, uses a shorter durable directory,
and supplies the original app's existing `controlPort` URL option. Each failed
attempt exited with independently verified scoped cleanup and all 323 committed
source-file hashes unchanged. Their safe evidence archives end in
`upgrade-fixture-v3-safe-failure-evidence.tar.gz` (SHA256
`291425a7379dffe0ac56dda9d41a53f6ed17b71370ecea288026fe5200339198`)
and `upgrade-fixture-v4-safe-failure-evidence.tar.gz` (SHA256
`03079432e03a4acc3319209bd40ea6c742d2ea68a3d12be58bce35f649bdef4a`)
in the same recovery directory.

The next run reached the real original profile UI and composer, then failed at
Hermes startup: the historical `cafc0a4` package exports
`open_harness_policy:register`, a function, while pinned Hermes expects a module
with a `register` attribute. A separate isolated inspection of the installed
package reproduced that mismatch and matched the loaded source to the original
commit. The fixture and original source were not weakened or patched to pass.
The run exited and exact-owned resources were removed; all 323 committed source
hashes remained unchanged. Safe evidence:
`Claude outputs/runtime-recovery-20260928/upgrade-fixture-v5-safe-failure-evidence.tar.gz`,
SHA256 `b1d1d3017d040a4890202d0bfc080e34416712f60211d346beba132242711e84`.

At that point historical upgrade/rollback acceptance remained unpassed. The separate existing
0.3 checkpoint `603b19b917fd9753f52599cf4d93a91728d67c0b` contains the documented
plugin-entry-point and custom-provider fixes. Its unchanged source was freshly
built on the native runner; image
`sha256:3dd863f4113a935cf6697e1d1ff65658f7172513d70de4dbd4179c9868baac66`
matches all eight runtime source files, and its installed plugin loads as a module
with callable `register` under the normal image user (UID 10001). The build kept
all 130 committed source files unchanged. Evidence is under
`Claude outputs/runtime-recovery-20260928/historical-603-build-v2/`.
This is a fresh observed build of a source checkpoint, not an official release
artifact, a reproducible dependency lock, or recovered original build attestation.
An earlier packaging-source inspection failed on directory permissions; the second
build corrected export modes, but cached COPY retained the extension input directory
as 0700. The separately installed policy module is 0644 and imports successfully;
the source-byte inspection ran as root. Both attempts and this limit are retained.

The first real test of this checkpoint completed the original UI profile checks,
composer submission, saved-credential authentication, and actual `write_file` job.
The DENY job then disproved the fixture's assumption that the old app cannot offer
an approval: it emitted a real approval request. Pinned Hermes's response handler
reads `choice`, defaulting to `deny`; this historical coordinator sends `decision`.
The revised fixture therefore requires both original UI choices to resolve through
the UI and leave the proof file unchanged, then requires the current app to perform
actual denial and approval correctly. Rollback must match the original behavior.
All 31 offline fixture tests pass on macOS Node 24 and Ubuntu Node 22. The failed
attempt's processes and exact-owned resources are gone; all 319 committed source
hashes are unchanged. Safe archive:
`Claude outputs/runtime-recovery-20260928/upgrade-fixture-v6-safe-failure-evidence.tar.gz`,
SHA256 `d18fd8381a88aa4409eb34cfde98ad4f317525c7dd78b0a79454404ed0aee41d`.
The next attempt passed all three original jobs, both actual approval choices and
their 0600 file effects, and browser close/reload. It then found the original
`/v1/runs/stop-all` route is shadowed by the run-ID route and returns 404. Its
cleanup and 319 source hashes were independently verified. Safe archive:
`Claude outputs/runtime-recovery-20260928/upgrade-fixture-v7-safe-failure-evidence.tar.gz`,
SHA256 `2c45449ebc0d1cff09fff2191e1acecd053637c8ca07e128f4bdfefa535f9adf`.
The fixture now first asserts every original run is terminal, uses the original
coordinator's supported SIGTERM shutdown, and still requires all inner containers
to stop before backup. All 32 offline checks pass on both platforms. A fresh full
attempt is running; no upgrade/rollback pass is claimed. The failed `cafc0a4`
baseline and its missing historical build attestation remain recorded.

## Fresh containerd builder checks — September 28, 2026

The new containerd builder context v2.1 was built successfully on the native
Ubuntu ARM64 runner at 21:22 UTC. The build took 22 seconds, returned exit 0,
and kept at least 31,557,226,496 bytes free. Docker image inspect reports
`sha256:e392deed324780f083b9e1a4f03209e1a8a3e27381190368b9d62e706347f8a3`;
the separately recorded image configuration digest is
`sha256:e919e20549376262d95ed56dd370c77305b724ca24ac7103fe51858a260235bd`.
The image uses the existing named `ubuntu` account, UID/GID 1000, has no default
command, entrypoint, healthcheck or volumes, and contains no Go toolchain or C
compiler. Actual build provenance records 38 tools, 14 versions, 137 package rows,
17 copied notices and 132 copyright files. A never-started inspection container
verified the shipped scripts and recorded provenance, then was removed by its
exact ID and ownership label. Durable evidence:
`Claude outputs/runtime-recovery-20260928/containerd-builder-v2.1-native-evidence.tar.gz`,
SHA256 `e53760d3c6b4f4afe6ddcd0f98b4572622d16d2de261121e2d40b7f801dd6541`.

The new phase controller passed 33 local synthetic lifecycle and refusal checks.
Its actual network-disabled bootstrap then passed on the above image at 21:25 UTC:
all 16,703 official Go tree entries and all 17 retained v5 recipe files matched
before and after execution; 40 actual clean-PATH tool identities were recorded;
30 overlapping tools matched image build provenance. It used a read-only root,
read-only Go and recipe mounts, one private writable work directory, UID/GID 1000,
dropped capabilities and bounded resources. The exact stopped container was removed.
Bootstrap SHA256:
`c52dc2f196d9371067faabcabdad051b7cd8b7cd84d2361edf1950b76a9b9afc`.
Evidence and root review are in
`Claude outputs/runtime-recovery-20260928/containerd-bootstrap-evidence/`.
The first v5 materialization exited 2 at source-archive creation: GNU tar 1.35
requires positional options such as `--no-recursion` before `--files-from`.
The failed attempt and logs remain in durable storage, with its process absent and
owned container removed. New recipe v6 changes that ordering plus revision notes
and checksums. A real native tar regression reproduced the old failure and verified
the corrected archive's exact file set, bytes, modes, symlinks, excluded untracked
file, fixed metadata and repeatability. See
`Claude outputs/runtime-recovery-20260928/containerd-tar-order-test.json`.

A fresh v6 bootstrap and materialization passed. Root independently verified the
complete source archive (6,487 regular files and three symlinks), all 16 bound recipe
and evidence inputs, tool identities, 332 resolved modules and 158 vendored modules.
Source manifest SHA256:
`be247747b0a405da0c0511be4c3405ec7816f16304576a48a924de99cc76f6a8`.
Materialization evidence:
`Claude outputs/runtime-recovery-20260928/containerd-v6-materialization-evidence.tar.gz`,
SHA256 `fb15a6f2f4be9d9ee03b136f8211f42d348ed0f2f8f86fbc1072e73110d8c7a7`.

The subsequent native ARM64 build ran with networking disabled and passed all
77 static validation checks for `containerd`, `containerd-shim-runc-v2` and `ctr`.
All three are static ARM64 executables with the reviewed Go version, source revision,
custom version, module versions and required dependency floors. Binaries were not
executed. The upstream Makefile's eager API test-package enumeration printed an
inconsistent-vendoring warning; that variable is unused by the completed binaries
target. No API tests are claimed. Build evidence, binaries and full logs:
`Claude outputs/runtime-recovery-20260928/containerd-v6-offline-build-evidence.tar.gz`,
SHA256 `f057375a4699f390b06a8247149ab3864181069dcc83c9cb9788f511c70a542c`.
Source tag signatures and dependency-lock reproduction remain separate from this
build result.

Fresh Trivy 0.74.0 scanning with the September 28 19:12 UTC database covers all
three exact binaries (234 package observations) and reports no HIGH/CRITICAL
vulnerabilities. An initial `fs` invocation detected zero binaries and is explicitly
not counted; `rootfs` detected all three. The secret scanner was enabled and reported
no findings, which does not establish absence of secrets embedded in compiled code.
Evidence: `Claude outputs/runtime-recovery-20260928/containerd-v6-scan-evidence.tar.gz`,
SHA256 `5cff4954ba1606ea0099f008c03d45032db2a3ca5ad239f9f45a3a0521f9f302`.

A separate engine candidate incorporates the three binaries and complete source,
vendor licenses and provenance over the prior Expat candidate, preserving its 17
base layers and runtime configuration except descriptive labels. Its Docker ID is
`sha256:48ec82717abe7c1993b94665c4a25be307a7ebb4fce6865278971c7e81ea6d75`.
A never-started image inspection verified binary bytes/ownership/permissions and
readable provenance. The first packaging attempt used incorrect directory permissions
for the notices; it is retained separately and was superseded before runtime use.

Fresh whole-image scans of the baseline and candidate using the same frozen database
show **27 → 8 HIGH**, zero CRITICAL, exactly 19 findings removed and none added.
The eight remaining findings are five in runc and three in Buildx. Both scans still
exit 1; the release gate remains closed. The application images and Compose defaults
have not adopted this candidate. Integrated acceptance is recorded below.
Comparison and complete reports are preserved in
`Claude outputs/runtime-recovery-20260928/containerd-v6-engine-scan-evidence.tar.gz`;
the corresponding root review records its archive and report hashes.

The original full Compose acceptance completed at 21:55 UTC in 180 seconds with
exit 0 and no supervision abort. It used the frozen `3a8f534` application source,
the unchanged final6 coordinator/Hermes images and the above containerd engine
candidate. Real scripted-provider checks covered authenticated browser pairing,
tool dispatch and denial, clarification, credential rotation/use, team/task and
conversation persistence, two simultaneous private desktops, actual click/type,
shared files, per-agent private files, explicit read/write folder grants, denied
host/control access, graceful shutdown, restart, and stopped backup into an empty
restore project. All 6,873 restored entries matched the recorded ownership, modes
and file hashes; real work and desktop input also passed after restore.

At 22:00 UTC an independent terminal inspection confirmed both original processes
absent, all containers/volumes/networks for both exact Compose projects removed,
no outer helper containers, all 189 staged source hashes/modes unchanged, and all
three image tags still resolving to their preflight IDs. The fixture did not retain
a contemporaneous image inspection for each running outer container; image binding
uses the resolved Compose configuration plus before/after tag inspections. The
desktop screenshot visibly contains the click/type markers. Minimum sampled free
space was 12,135,530,496 bytes. The 12-member safe archive was copied and every
manifest entry reverified locally:
`Claude outputs/runtime-recovery-20260928/compose-containerd-v6-safe-evidence.tar.gz`,
SHA256 `05637849da947d2b264f054dd873a297ca67c39858c369952fe0a8fc8671f7ef`.
Authoritative fixture evidence SHA256:
`1dcabb3f022a8b822edb76e72baa4e3b5831fd76e926926333981b523f35373a`.
This establishes native Linux ARM64 tool/transport behavior, not model reasoning,
historical version upgrade, Mac/Windows/AMD64 acceptance, or release clearance.
The eight remaining engine HIGH findings and other release gates remain open.

## Fresh runc build checks — September 28, 2026

Fresh runc preparation also advanced on September 28. The retained v2.1 builder
context built successfully on native ARM64 in 26 seconds, using the newly verified
official Debian trixie index
`sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a`.
Builder image inspect ID:
`sha256:5416ed2f37889120f25f3e702b553125678b89175504398caa0a9ef0ab0ab249`;
separate exported config digest:
`sha256:7cb85e9bbc075f3b110121db8d2dc6d9f08b954ba2ee99fa5c1886743ce6a72b`.
A never-started inspection verified the named `oh-build` UID/GID 1000 account,
read-only provenance/scripts, 45 tools, 17 versions, 11 static link inputs, ten
notices and 171 installed package rows, then removed its exact container. Actual
inputs include GCC 14.2.0, glibc `2.41-12+deb13u4` and libseccomp `2.6.0-2`.
Evidence archive `Claude outputs/runtime-recovery-20260928/runc-builder-v2.1-native-evidence.tar.gz`,
SHA256 `c22e672bb812db40ed433b9bb2660c8f4d737c496cbbd9723957d74760b5c29b`.

The original runc 1.5.2 source was reacquired from its official release, SHA256
`46eba094e45fc37d96a1b1dc150971fe8d076d6e23bae09dd35443141bed31a1`.
All source archive blobs match commit `29dd3dc2b13b4123162e5fe132504bb4b15569f1`,
with no tracked files missing. Its signature freshly verifies against signer
`C2428CD75720FACDCF76B6EA17DE5ECB75A1100E`, using the keyring from that pinned
upstream commit. An initial direct gpgv call rejected the text/armored keyring;
the retained corrected receipt imports it in a task-private keyring and exports
the exact signer for verification. No global trust configuration was changed.
Receipts and all 1,389 source archive entries are retained under
`Claude outputs/runtime-recovery-20260928/runc-source-recovery/`.

A new runc controller/recipe passed 34 offline lifecycle/refusal checks and 12
offline source/binary-contract tests. Its network-disabled native bootstrap
recorded 47 tools, matched 37 overlapping tool hashes to the builder, and verified
all 11 static C inputs. Full Go-tree and recipe hashes matched before/after every
phase. Bootstrap SHA256:
`83ad21d39adbd2a47565297170b55ac63f1de0cdfdc7b7bdc7b9de10037fa8c0`.
Materialization then passed with the sole go.mod change `x/net v0.55.0 → v0.56.0`,
55 resolved modules and 27 vendored modules. Independent review checked all 1,388
exported source entries, module graph and checksums. Source manifest SHA256:
`1805c2b16de19e2898a9bfa4e71f8a9d8f3c0aedd22689798ea258b3f047e80a`.
Materialization evidence archive SHA256:
`2518759fac9a4e7fdd82d4be5ac1befb426ecb823a2aa499dceeb751503b80bc`, at
`Claude outputs/runtime-recovery-20260928/runc-v1-materialization-evidence.tar.gz`.
The subsequent network-disabled ARM64 build passed at 22:16 UTC. The 13,244,664-byte
binary has SHA256
`9b8ba829d9ab651a98d8cbc400d715809fa8b1ba1ebac7a5b38b70c055942a73`.
Independent ELF parsing confirms ARM64 static PIE without an interpreter or needed
shared libraries. Go build information records Go 1.26.8, CGO enabled, seccomp enabled,
libpathrs disabled, the expected source/version stamps and all 23 compiled dependencies
matching the reviewed graph. The upstream Makefile prints a git-describe diagnostic
because the signed archive has no `.git`; explicit commit/version arguments are
present in the command and binary. Build archive SHA256
`fd0e287a6b34a438c64d112bc9fe328418103941238454703c64b32bbc6ca6ac`, at
`Claude outputs/runtime-recovery-20260928/runc-v1-offline-build-evidence.tar.gz`.

Trivy's Go executable scan detects 25 packages and no HIGH/CRITICAL findings.
Its main-module version is `(devel)`; the exact upstream version is separately bound
by the signed source and stamped version, not inferred from that scanner field.
A separate scan of all 171 Debian builder packages has 160 findings overall, but
none for any installed package from the exact glibc, GCC 14 or libseccomp source
versions supplying the recorded static link inputs. The builder image is not shipped
as runtime. Complete reports and scope review are retained in
`Claude outputs/runtime-recovery-20260928/runc-v1-scan-evidence.tar.gz`, SHA256
`072d8ab60182766bfad600fed7253063241fc5c372808e42c9dc76c80d0b4ffe`.

The derived engine image
`sha256:048d3e40d077ad936d3868e32df6630351ebd5c7a4ccdf5a736eadac67599d55`
adds only the replacement runc, corresponding source archives, notices and build
provenance over the tested containerd candidate. All 19 base layers and runtime
configuration except descriptive labels are preserved. Its 61 shipped files were
verified by a never-started inspection container, including ownership/permissions.
Matching Debian sources and packaging patches total 118,407,001 bytes; all seven
downloads match sizes and SHA256 entries in the official source descriptors. The
descriptor signatures were not independently verified. Engine build evidence:
`Claude outputs/runtime-recovery-20260928/runc-v1-engine-build-evidence.tar.gz`,
SHA256 `f5f006df1a03ac78b87f2a28dc15c80ff3fbc456bbfcdcac539787b760dd2a6c`.

Using the same frozen database, whole-engine scanning shows **8 → 3 HIGH**, zero
CRITICAL, exactly five removed and none added. All remaining findings are in Buildx;
the gate still exits 1. Full report/comparison archive:
`Claude outputs/runtime-recovery-20260928/runc-v1-engine-scan-evidence.tar.gz`,
SHA256 `a05296aeda860e0b80f328a2338e20f56c798bd6f03f25f5bc95b1967fe4bff8`.
Application images and deployment defaults remain unchanged. Full replacement-engine
Compose acceptance passed at 22:33 UTC in 175 seconds, with no abort. Independent
22:34 terminal inspection confirms all 189 source hashes/modes unchanged, both
original processes absent, both exact projects' containers/volumes/networks removed,
and no outer helper containers. All 6,873 restored entries and the complete functional
checks described for the earlier Compose run passed again, including actual desktop
input after restore. The screenshot visibly contains both expected input markers.

This run additionally retains contemporaneous image inspections for all six outer
containers across the original and restored projects. Both actual engine instances
report the exact stamped runc version/commit, Go 1.26.8, libseccomp 2.6.0, and the
reviewed binary SHA256. Minimum sampled free space was 10,253,357,056 bytes. The
14-member safe archive was copied locally and every manifest entry reverified:
`Claude outputs/runtime-recovery-20260928/compose-runc-v1-safe-evidence.tar.gz`, SHA256
`8c60309dccb9e518f884d911374c52aa85c3eef56c2e1a8b61be34f1d9fbac0e`.
Authoritative fixture evidence SHA256:
`e69761021be6f6ff5db8a27cf4993a0c21bb3c3a27053a6921ab922bc6de8954`.
This is native Linux ARM64 scripted-provider acceptance. The three remaining engine
findings, broader application image gates, historical upgrade/rollback, native
Mac/Windows/AMD64 acceptance and publication are still open.

## Evidence availability — September 28, 2026

SSH access was restored at 19:31 UTC using the existing connection. Fresh checks
confirmed all 19 known temporary task paths are absent on Ubuntu. The exact seven
historical, final6, Expat and supporting image IDs remain cached as Linux ARM64
images; Docker reports no containers or volumes. This establishes current inventory,
not the missing attempt's failure cause or historical cleanup. Durable observation:
`Claude outputs/runtime-recovery-20260928/native-images-and-resources.json`, SHA256
`d62d5ecd4d9b279d8fd4baf560337446f99ce7b260837b63cb77ab13b730ba34`.
Fresh verification tooling is being prepared as new revisions with durable outputs;
none of the missing test results is reconstructed or claimed as newly verified.

At 07:11–07:14 UTC, the previously recorded local `/private/tmp` evidence archives,
preparation directories and checkpoint indexes were absent. Repository files, the
candidate worktree and the ZIP artifacts in `Claude outputs/` remain present. The
entries below retain their original historical scope; their temporary-file links
must not be treated as currently available evidence. Recovery from the original
Ubuntu runner is pending because the existing SSH connection timed out. No fresh
remote cleanup, source-integrity or image-identity check succeeded in that interval.
The availability inventory is recorded in
`Claude outputs/evidence-availability-checkpoint-20260928-0717.json` (SHA256
`7b6065eec686ea0da11b438ac56b838daf70092a300da862f9f445c44293214a`).

The fourth historical-upgrade attempt was observed in the prior session to exit 1
at 04:15:14 UTC, after both UI builds and historical runtime health passed. Its
specific browser failure, complete cleanup and original source hashes still need
inspection of the retained remote files. No upgrade/rollback pass is claimed, and
an inaccessible log is not grounds to restart the fixture.

The retained final runc builder preparation ZIP has now been independently matched
to a complete unprivileged synthetic run: **56 checks passed, exit 0**, empty stderr,
with all shipped file hashes verified before and after. The evidence ZIP SHA256 is
`dbac5850eeb17e63656fcaf48fc95bc8f61c0a493d9fce824b75ee3dd270e5d0`; its 20 regular
files and 19 manifest payloads were verified. Root review:
`Claude outputs/runc-v2-nobody-root-review-20260928.json`, SHA256
`e0e591eeb8b68477cdc22987e36428fb44a99270e675e18c5b87c0f2cdee8d0e`.
This covers synthetic provenance/account checks only. The actual builder, exact
recipe-environment provenance, dependency resolution and compilation remain untested.
The earlier root-run receipt still lacks full per-case output and an explicit exit.

## Final local browser checkpoint — September 26, 2026

The final unreleased runtime-contract-6 source passes **218 Node tests**, with one
expected platform skip, **120 desktop/mobile browser tests**, typecheck, full lint,
and the production build on Ubuntu 24.04 ARM64. PowerShell 7.6.6 was on PATH for the
Node suite, so both launcher implementations ran. The final run corrected two test
assumptions: the Dockerfile layer check now distinguishes early dependency constraints
from the late managed-policy copy, and the Compose environment fixture preserves the
required `ProcessEnv` type. The affected contract/packaging tests pass **21/21**.
Application, runtime and image-build source remained unchanged after the image freeze.
Logs: `/private/tmp/oh-browser-contract6-integrated-checks-final.log` and
`/private/tmp/oh-browser-contract6-static-browser.log`.

The **actual downloaded ZIP/tar rehearsal passes** with the final coordinator, Hermes
and official Docker 29.8.1 engine. It verifies an empty-engine anonymous digest pull
from a disposable loopback registry (34.35 seconds), launcher pairing and replay
refusal, manual same-document pairing without reload, and immediate guide dismissal
after setup. A real cached `available:false` response was observed, followed by the
sidebar becoming ready without reloading. Chromium opened before the first computer
driver call supports real clicking and typing with DOM readback before and after
launcher stop/restart. Closing the browser preserves active work; profiles, tasks,
private/shared files, the data volume and the paired browser credential survive.
All 23 captured source hashes match. The final and failed locator-only fixture
resources were cleaned. Safe evidence:
`/private/tmp/open-harness-local-package-contract6-evidence-20260926.tar.gz`, SHA256
`05d828fea907265a546ff5fcb17c68591bdf8e28463088a64152370912147aa9`.
This is a Linux ARM64 local-registry rehearsal, not published GHCR acceptance or the
production validator's two-architecture gate.

A subsequent full `tests/compose-smoke.mjs` run against these **same final images**
also passes stopped-backup/empty-volume restore. All **6,873** entries match content
hashes, ownership and permissions. Restored profiles, rotated credentials used by an
actual follow-up run, private/shared files, memory, skills, tasks and history survive;
uncertain interrupted work is not replayed. A fresh engine cache and actual desktop
click/type after restore pass, along with pairing/authorization, explicit folder
grants and two-agent desktop isolation. This fixture streams the prebuilt runtime
image into its private engines; it complements the separate real digest-pull rehearsal
above. Both disposable projects and their volumes/networks were removed, and the
credential-bearing raw backup was deleted after exporting safe evidence. Archive:
`/private/tmp/open-harness-final6-backup-restore-evidence-20260926.tar.gz`, SHA256
`a644aa47c2b46f06752a216fb3037d823e20626fe4d3749812f6e8a3104981b0`.
This restores a final-version installation; older-version upgrade/rollback remains
a separate release requirement. Full-duration endurance evidence is recorded below.

A supplementary **v0.3.0 data upgrade and backup rollback** check passes 128
assertions. The unchanged historical backend at `cafc0a4` created its state through
ordinary APIs; all 42 captured historical source hashes match that commit. Final6
preserved 37 original rows across 15 populated tables, profiles/revisions, events,
routines, task data, memory, skills, private/shared files, credentials and the operator
token. The current entrypoint refused existing root-owned data without changing it;
the documented application-volume ownership migration enabled startup. Restoring the
pre-upgrade backup into a separate empty volume recovered schema 0 and original root
ownership, excluded post-upgrade changes, and allowed the old backend to work again.
All owned containers/volumes were removed. Safe evidence:
`/private/tmp/open-harness-upgrade-v030-evidence-20260926.tar.gz`, SHA256
`7ed52ca4fbe6694f2a38954b0fb8aa4d4c4700aca23ba70b150ec634c24bec39`.

This is data/API/credential/backup compatibility evidence with **mocked run execution**.
It does not exercise a historical Hermes image, old dashboard/installer, real inference
or a desktop-runtime upgrade. Final6's service was invoked directly because its
production supervisor correctly forces live mode. The full historical-upgrade release
checkbox remains open; actual current-runtime/Compose evidence is recorded separately.

The first **real historical-source upgrade attempt** on September 28, 2026 passed
both production dashboard builds, then stopped at the historical Hermes image's
1,200-second build deadline while downloading Python dependencies. The build log
acknowledges cancellation; the original process and build clients were absent, and
independent label-scoped checks found no remaining fixture containers, volumes or
networks. All 134 historical and 189 current original source files still match their
captured hashes. Migration and rollback never started, so this attempt does not
satisfy the historical-upgrade gate. Safe evidence archive:
`/private/tmp/open-harness-full-upgrade-attempt1-evidence-20260928.tar.gz`, SHA256
`8b353be85d8a785f5f3a6b2e3f5df5058ed73289cf0ef2542be643e83280ad0f`.
The observation does not independently inventory daemon-internal BuildKit workers.

A separate **second historical-source attempt** completed the original historical
Hermes image build on September 28, then failed the unchanged 12 GiB free-space
precheck before creating the baseline engine or its volume. Both production UI
builds passed. The historical image remains cached as Docker image ID
`sha256:43b18a934ccadd428c68db28d9d24173995fdbe3a7f71ed7fd57fd2c2d356275`;
the build's configuration digest is recorded separately. Independent checks found
the original processes absent and all fixture-owned containers, volumes and
networks removed. All 134 historical and 189 current original source hashes match.
The exact free bytes at the failing precheck were not recorded; a later 17.54 GiB
reading does not describe that instant. No baseline runtime, upgrade or rollback
acceptance was reached. The independently verified 12-file safe archive is
`/private/tmp/open-harness-historical-attempt2-safe-evidence-j4v7tyf6.tar.gz`, SHA256
`b8cf268dac223a898c8c5f3ef1aafe87282ac25e899cce027e2354fb627db072`.
A separate fixture change is being prepared to reuse that exact historical image
with verified source and build evidence; this is not a completed retry or a lower
resource threshold.

The **third attempt** reused the exact reviewed historical image with checksum-bound
build/source evidence. Both production UI builds and historical runtime health passed;
the baseline engine reported configuration ID
`sha256:286e0e35a0b57fa0ded4ac3c022237636dadc7a33ad4083625fc8aefc540044f`,
recorded separately from the outer Docker image ID. It failed before submitting work:
the exact-label browser locator could not find the populated description textarea,
although the captured accessibility tree showed the expected name and value. A separate
real-Chromium static-field reproduction confirms that defect; an exact textbox-role
locator passes the same value assertion and rejects a wrong value. No application
source or assertion value was changed. Attempt 3 exited 1 after 135.71 seconds;
all owned resources and original processes are gone, and all 134 historical plus
189 current original source hashes match. Upgrade and rollback remain untested.
Independently verified 13-file safe archive:
`/private/tmp/open-harness-historical-attempt3-safe-evidence-097uplaz.tar.gz`, SHA256
`ad8fe6608814df7707d83c7614f27f05787468888713dca2e4ad3b7709de2de9`.

The reviewed soak fixture also passes a **368.33-second rehearsal** on these exact
final images: six actual core-tool runs and six conversation follow-ups, six pending
approval browser reconnects (three approvals and three denials with file-mode checks),
one coordinator restart with persistence, and actual desktop click/type at start,
after restart and at end. Seven disk/health samples show at least 9.55 GB free and at
most 129.1 MB application-data growth. All owned containers, volumes and networks were
removed. Safe evidence:
`/private/tmp/open-harness-soak-rehearsal-evidence-20260927.tar.gz`, SHA256
`20b39b9265ca34dfad3439f6f1a758d35c710f04c0b334c285a35fb87bf4fcee`.
This short run explicitly reports `twentyFourHoursCompleted:false`.

The subsequent **full 24-hour run passed on September 28, 2026**, after
**86,411.20 seconds** with 900-second task intervals. It completed 96 real core-tool
runs, 96 conversation follow-ups and 96 browser-reconnected approval flows: 48
approvals and 48 denials with actual file-mode checks. One planned coordinator
restart preserved the profile, task, credential fingerprint, private/shared files,
memory and skill; real desktop click/type passed at start, after restart and at end.
The final report records `ok:true`, `twentyFourHoursCompleted:true` and
`resourcesRemoved:true`. Root independently confirmed the original PID was absent
and the exact Compose project's containers, volumes and networks were empty.
The seven captured source hashes still match the frozen build; the harness is
unchanged. The final desktop screenshot was visually reviewed. Final report:
`/private/tmp/open-harness-final6-soak24h-evidence-yfh0ozox/evidence.json`, SHA256
`4d7cbee2046053f24bf92eac599aeb0cd102e3d451bd696ed594f72714fca463`.
All 1,441 metric samples are valid and report runtime readiness. Fixture-data growth
peaked at 141.21 MiB. Engine/coordinator memory ended at 386.8/170.1 MiB, below their
observed 961.4/177.3 MiB peaks; recent averages remained elevated, so these measurements
do not establish the absence of a leak. Cleanup left 23.39 GiB free. The independently
reviewed 14-file evidence archive is
`/private/tmp/open-harness-final6-soak24h-evidence-20260928.tar.gz`, SHA256
`1edad103fbad64ed3c5a6680bff7e5ae6975139d94922fd2a6ee2511be792665`.
This establishes endurance for the exact Linux ARM64 images below using the local
scripted provider. It does not establish model reasoning, native Mac/Windows or
AMD64 acceptance, cleared vulnerability gates, publication, or acceptance of a
subsequent replacement image.

The final real-Hermes protocol fixture also passes tools, clarification, task MCP,
approval/denial side effects and conversation continuity. Its exact-image evidence is
`/private/tmp/open-harness-final6-evidence-20260926-UdSjwSPu/`. The image identities are:

| Image | Immutable Docker index ID | Separate BuildKit configuration digest |
| --- | --- | --- |
| Coordinator | `sha256:cd1085b10dc3576c7522e3c03ddc3cd478c411bd8d13cd401c05980a913ba8c9` | `sha256:4240e454cb76603b7b2cf061e91227f5de369eef3e83cd834de28bbf0b9a242d` |
| Hermes | `sha256:d81b01ed79d179a028a712831e89415aee0d4b629d238bf567435dd230782bb2` | `sha256:3bcb755402cec22e13a4de0a23c393e78a33f6aec80d0911898c2bd843f9cd36` |

The unchanged strict Trivy 0.74.0 HIGH/CRITICAL vulnerability and secret gate **still
fails all three images**. No unfixed finding is suppressed. Occurrence counts are not
an exploitability assessment; zero HIGH/CRITICAL secret findings is not an all-secrets
guarantee.

| Image | HIGH | CRITICAL | Distinct vulnerability IDs |
| --- | ---: | ---: | ---: |
| Final coordinator | 54 | 0 | 15 |
| Final Hermes | 94 | 1 | 36 |
| Exact official Docker 29.8.1 engine | 28 | 0 | 16 |

Final coordinator evidence is
`/private/tmp/open-harness-coordinator6-final-evidence-20260926.tar.gz`, SHA256
`e01a6dc951c303c326f081ce67eacf7696565774f7807306daa8725489c04fdf`.
The engine reference is
`docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`;
its earlier exact-image scan and full Compose restore evidence remain applicable.

A separate ARM64 engine candidate updates only Alpine Expat from 2.8.4-r0 to
2.8.5-r0; its strict scan still fails with 27 HIGH findings. Its first actual
Compose acceptance attempt on September 28 reached backup/restore and restored
desktop checks, but **failed final cleanup verification**: Docker returned lowercase
`error: no such object:` for five normally auto-removed helpers, and the fixture's
case-sensitive classifier rejected that response. All five helper processes exited
zero. Independent checks confirmed both fixture projects and owned helpers had no
remaining containers, volumes or networks. Both engine instances used candidate
Docker image ID `sha256:175c64e538ee38674f1af1ea7a7b7776b22b7dd151f351a5ae7f431d078cc0b1`.
The empty-destination restore compared 6,873 entries. Functional completion is
supported by the preserved fixture control flow; this failed attempt is not an
acceptance pass. Safe evidence archive:
`/private/tmp/open-harness-expat-attempt1-safe-evidence-bqzdd7c2.tar.gz`, SHA256
`150ea989b93d4b4eaeb01425aca00e5655922450c51a49d75af3f0c5f77effa7`.
The separately reviewed one-line classifier correction preserves exact target and
exit-code matching and rejects mixed diagnostics; 25 focused fake-child tests pass.
Neither this correction nor candidate acceptance clears the remaining release gates.

The corrected fixture's **separate second attempt passed**, finishing at
03:23:13 UTC on September 28, 2026 with exit 0. The same candidate engine passed
real tools/input/task-MCP, approvals, explicit folder grants, private/shared file
checks, two private desktops, restart, and stopped backup/empty-volume restore.
All 6,873 restored entries matched; restored credentials were used by follow-up
work, and desktop click/type passed. The authoritative report records clean
helpers and both projects removed. Independent inventories were empty, both
original processes were absent, and all 190 staged source hashes still matched.
The shared dependency tree was not rehashed. Supervision observed at least
13,874,454,528 free bytes with no abort or sampling error. Both engine instances
reported the exact candidate image ID above. The final desktop screenshot was
visually reviewed. Authoritative evidence SHA256:
`4bef6efac603317191f87be1936c8b70692a40537127aaa00bbd864427099554`.
Safe 13-file archive:
`/private/tmp/open-harness-expat-attempt2-safe-evidence-l7z754j_.tar.gz`, SHA256
`96645a6fad990fb2fef4709c4e3a250dc584e6d1f63654a81116fd30764d9cf4`.
This accepts that separate local Linux ARM64 candidate with the frozen coordinator,
Hermes image and scripted provider. Production image references remain unchanged;
27 HIGH engine findings, native-platform tests and publication remain open.

Packaging now writes the stable default project name `open-harness`. Actual Compose
normalization across two versioned extraction folders confirms the same application
volume; environment and CLI project-name overrides still take precedence. The strict
Ubuntu packaging checks pass 12/12. Evidence:
`/private/tmp/open-harness-project-name-evidence-20260926-E6KX03ih/`.

Local source checkpoint `550f765906b7451899a8b23e9b149f84f9f6d374` is committed
in the isolated release-candidate worktree. Its actual Git-HEAD source archive contains
**189** matching tracked files, preserves executable launcher modes, and excludes local
state, conflict copies and collaboration artifacts. The original working tree and its
index were preserved. Archive:
`/private/tmp/open-harness-source-candidate-20260926-dlfh2zos/open-harness-self-hosted-0.4.0-beta.1.tar.gz`,
SHA256 `bf4c77e871570b5757a139bc62e25672ac23aea23393223e18912016d65679b1`.
Verified Trivy 0.74.0 scanned that exact extracted source for secrets at **all severities**
with an empty ignore file: exit 0, zero detections. Evidence:
`/private/tmp/open-harness-source-secret-evidence-20260926-3XulSe4t/evidence.tar.gz`, SHA256
`57c87754cbf85b831bdc1abd0a77923d5f0003a206811939cd77aabb96ec5f05`.
This source scan does not clear the separate image vulnerability gates. The pre-existing
local images have source-hash evidence; a published candidate must still be rebuilt and
validated from its final tagged source with matching image revision labels.

**Release remains blocked:** resolve the image scan findings, validate native AMD64
images, run Docker Desktop acceptance on Apple Silicon Mac, Intel Mac and Windows,
and publish/verify the committed-source multiarch packages. No image, tag, release or
PR has been published during this work. The current Mac VM has no hypervisor support;
its Bash launcher tests cannot establish Docker Desktop support. Signed native
installers remain a separate acceptance path.

Claude Desktop's separate Ubuntu AMD64 microVM was checked as a possible builder.
Its installed Docker 29.4.3 engine started on a temporary private Unix socket and
ran a minimal local container, but the normal Docker Hub image pull failed with
`403 Forbidden` from the environment's mandatory proxy. GHCR CONNECT was also
denied. No Open Harness AMD64 image was built or pulled, no registry relay or proxy
workaround was used, and no global trust configuration changed. Claude reported
verified cleanup of its temporary daemon, containers, networking and data roots.
This establishes an environment access blocker, not AMD64 product acceptance.

## Earlier local browser integration checkpoints — September 26, 2026

The Docker browser work is **not yet a published or platform-accepted Mac/Windows
release**. The following evidence is from Ubuntu 24.04 ARM64, Node 22.23.3, Docker
Engine 29.8.1 and Compose 5.5.1. Source Compose/restore and a separate downloaded-archive
rehearsal are recorded below. The latter pulls anonymously from a disposable loopback
registry; it is not a published GHCR release or a production image-lock validation.
The scripted local model fixture verifies transport/tools/state; no paid provider or
model-reasoning acceptance was performed here.

Current source changes include mandatory one-use CLI/browser pairing for Compose,
minimal public readiness separate from authenticated diagnostics, digest-pinned runtime
setup without a source-build fallback, and host-folder grants restricted to exact
explicitly exported outer mount roots with a read-only ceiling. Subfolders require
their own export. Compose rejects localhost-only host model URLs before provider
requests or profile writes; a host-model relay is not implemented. Claude delivered the
browser client, host-folder editor and launchers; the final reviewed delivery passes
**214** Node tests (three expected skips), typecheck, full lint, production build, and
all **110** desktop/mobile browser tests in the Ubuntu integration copy
(`/private/tmp/oh-browser-final-integrated.log`). A separate run with verified official
PowerShell **7.6.6** on Linux passes all **17** launcher cases, including both previously
skipped PowerShell cases (`/private/tmp/oh-browser-final-powershell.log`). The Mac VM
presents Bash **3.2** and passes **26** launcher/packaging checks with two expected
PowerShell skips (`/private/tmp/oh-browser-final-mac-launchers.log`). The subsequent
packaging-only change bundles the backup/restore guide alongside the installation guide;
ZIP/tar checks pass **11/11** (`/private/tmp/oh-browser-final-package-tests.log`). These
launcher cases use fake Docker responses. Pairing UI coverage uses mocked routes;
the completed real package rehearsal below covers the original full-page pairing path.
It exposed two UI follow-ups still being integrated: manual pairing after a same-document
fragment change, and an outdated sidebar runtime label after successful setup.

Actual `tests/compose-smoke.mjs` acceptance passed against runtime contract **4**:

- Unauthorized, expired and replayed pairing attempts fail; authenticated control,
  forged-Host refusal and nested-agent operator-token denial pass. The private engine
  exposes no TCP listener, and the coordinator/data use UID 1000.
- Actual Hermes file, clarification, task MCP, denied-tool and prior-conversation flows
  work. A saved credential is rotated, then used successfully by subsequent real requests.
- Physical exported folders with spaces preserve read-only/read-write grants for the
  selected agent. Ungranted peers, `/data`, and unexported descendant paths are denied.
- Browser-first accessibility clicks, typing with DOM readback and PNG screenshots work
  in the private desktop. Two agents have separate private files and windows; Shared
  files remain intentionally shared. Graceful stop terminates active work.
- A stopped data archive restores into an independently named **empty** application
  volume. All **6,725** file/directory entries match hashes, ownership and permissions
  before reopening. Profiles, rotated credentials, private/shared files, memory, skills,
  tasks and history survive. A real conversation uses the restored credential, uncertain
  interrupted work is not replayed, and actual desktop input works again after restore
  with a fresh private-engine cache.

This gate exposed and fixed an unauthenticated-bootstrap health probe and a private
accessibility startup-order defect. The session now enables accessibility before any
application launches; old images require a full contract-4 rebuild or the matching
release image, not a policy-only patch. The permanent fixture launches Chromium before
its first computer-driver call so doctor initialization cannot mask this regression.

The full Node checkpoint passes **183/183**, typecheck and full lint. Subsequent release-packaging checks pass **11/11**, scoped lint and actionlint, including Docker 29 containerd index/configuration-digest separation reproduced from real BuildKit history. No registry mutation was performed. Test output is
`/private/tmp/oh-browser-local-runtime-checks-4.log`. Exact runtime/helper hashes and
Docker image IDs plus their separate BuildKit configuration digests are in
`/private/tmp/open-harness-browser-acceptance-evidence-20260926.tar.gz`. It contains
safe evidence/logs/screenshots only; the credential-bearing backup and raw state are
excluded. All acceptance containers, volumes and networks were removed. Isolated test
image tags are retained for final integration; prior installation tags are unchanged.

A subsequent **contract-5** image adds synchronous desktop-initialization completion
for native Linux selected-folder startup. Actual ordinary Docker checks verify pinned
folder admission, read-only write refusal, read/write persistence, immediate X11/D-Bus
and desktop-driver readiness, inert manual restart, and fresh containers on new
admission. Focused Linux checks pass 27 tests with one expected platform skip; scoped
TypeScript and lint pass. Safe evidence is
`/private/tmp/open-harness-native-folder-evidence-20260926.tar.gz`. This is separate from
the contract-4 Compose/restore evidence above; final contract-5 integration is in progress.

A **contract-5 downloaded-package rehearsal** now passes on Linux ARM64. Both ZIP and
tar extract into a path with spaces with matching contents/modes and the offline
backup/restore guide. The actual launcher starts the stack, mints a one-use code, and
the real browser exchanges it; plain unpaired access and replay are refused. First-run
setup anonymously pulls the exact runtime digest into an initially empty private
engine (55 seconds in this run). Chromium is opened before the first computer-driver
call; accessibility click/type with DOM readback works before and after launcher
stop/relaunch. Work waiting for input remains active while the browser is closed.
Profiles, tasks, private/shared files and the browser credential persist across restart.
All fixture resources are cleaned, without touching earlier image tags. Safe evidence:
`/private/tmp/open-harness-local-package-evidence-20260926.tar.gz`, SHA256
`22b253bfb5309a62dde8edbc602f83ce7ad9b0b8c79364d5f398a555ce3ce593`. This uses a
fixture-only ARM64 lock/local registry; the production validator remains unchanged and
requires both architectures, official image repositories, and the release revision.

Production dependency audit on September 26 reports **0** known vulnerabilities. That
result covers npm production dependencies, not the agent image. The actual contract-5
Hermes image **fails** the required Trivy 0.74.0 release gate: 363 HIGH and 23 CRITICAL
occurrences, representing 287 distinct vulnerability IDs. The exact scanned Docker ID is
`sha256:df5c74e123e2a01537466f2a894a79d9da5e3f28b0c01ef4efbf6507f8873d6a`.
No HIGH/CRITICAL secret findings were reported. The scan uses the September 26 database,
no ignore file and no suppression of unfixed issues. Most findings are Debian package
families (including development headers); npm's bundled libraries and pinned Python
HTTP dependencies also require review. Occurrence counts do not establish exploitability.
Safe provenance and the private report are under
`/private/tmp/open-harness-release-scan-20260926-pFenT5hv/`. Publication is blocked while
an isolated dependency/base-image remediation candidate is evaluated. The release scan
gate remains unchanged.

The rebuilt functional coordinator also fails the unchanged image gate: **84 HIGH**
and **5 CRITICAL** occurrences, **45** distinct IDs. Its Docker image ID is
`sha256:5af91d089d6bd2c96886ec4543e7760c42dc3a51ad9d1cd2b5a09f1c5016f43c`;
its separate BuildKit configuration digest is
`sha256:ab5eb5c698061a800f47d9bbec88b5be730b174af5d5d72bb11e851568ab287e`.
An isolated Hermes packaging candidate updates the supported Debian base, Node/npm and
matching Python HTTP dependencies without changing Hermes's pinned reasoning source.
The final packaging candidate passes the full real Hermes protocol and private-desktop
fixtures, 920 native-library checks, and ordinary selected-folder/recreation checks.
The tests caught and corrected Trixie's restrictive `/home/hermes` parent mode and a
second HTTP dependency pin in Hermes's lazy installer. Both dependency metadata files
are hash-checked before the narrow version override; reasoning control flow is unchanged.
The image still fails the same scan with **94 HIGH** and **1 CRITICAL** occurrences,
**36** distinct IDs, all from Debian packages. Safe evidence is under
`/private/tmp/open-harness-hermes-candidate4-evidence-20260926-hlYjEK0A/`.
The verified packaging changes are now integrated into unreleased source with runtime
contract **6**; its separate final image rebuild and combined acceptance are in progress.
Neither image is approved for publication. No HIGH/CRITICAL secret findings were
reported in either scan. Scanner counts do not establish exploitability.

The revised coordinator packaging uses pinned Node 24/Trixie, verified npm 11.20
and the official Docker CLI/Buildx, retaining the curl health probe and removing the
unused coordinator daemon stack. It passes the full ordinary Compose agent, desktop,
restart and stopped-backup/restore fixture, plus a benign source-build transport check.
Its strict scan still fails with **54 HIGH**, **0 CRITICAL** findings (15 distinct IDs).
Safe evidence is `/private/tmp/open-harness-coordinator-candidate-evidence-20260926.tar.gz`.
The release workflow now also scans the exact private-engine manifest for each native
architecture; the previously cached Engine 28.5.2 image fails with **348 HIGH** and
**15 CRITICAL** findings. A current official Engine 29.8.1 candidate reduces these to
**28 HIGH**, **0 CRITICAL**, but still fails the gate. Its full ordinary Compose
fixture passes engine API/source-build transport, Unix-socket-only isolation, browser
pairing, agent/desktop/folder behavior, restart and empty-volume restore. Both native
architecture manifests exist; execution here is ARM64 only. Safe evidence is
`/private/tmp/open-harness-dind29-candidate-evidence-20260926.tar.gz`. Source Compose and
release resolution now use the tested official 29.8.1 multiarch digest
`sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`.
No findings are suppressed.

Outstanding before release: verify the two observed UI corrections against a rebuilt downloaded package;
package the final committed source; run native AMD64/ARM64 build/scan/publish and
anonymous downloaded ZIP/tar/launcher acceptance; make the release image packages
public; and test Docker Desktop on Apple Silicon Mac, Intel Mac and Windows. Current
Mac access is a VM without hypervisor support (`kern.hv_support=0`), so it cannot serve
as Docker Desktop acceptance. Signed native desktop installers remain separate. The
release workflow implementation is preparation, not evidence that those gates ran.

## Sandboxed computer control — September 26, 2026

This follow-up supersedes the native Direct Computer Access availability described in
older entries. Computer control uses the existing per-agent Docker boundary and a
private Linux Xvfb/Openbox desktop. Shared workspace files remain shared. Native
Direct / Existing desktop profiles stay readable for explicit conversion but are
rejected at save, run creation/start, discovery/probes, transfer, runner execution and
persisted command polling. No host Python or desktop-session fallback remains in the
coordinator, runner or installers. Saved local native PID identities still receive
upgrade cleanup. Already admitted work on older remote runner binaries requires
stopping and updating those runners.

Codex and Claude Desktop agreed this contract after reviewing native process sandboxing:
controlling the operator's existing desktop can drive applications outside a process
sandbox. A sandbox-exec prototype denied an ungranted file, but does not establish desktop
isolation; it was not shipped. No new sandbox dependency or system-wide security bypass
was added. These changes alter container-isolation enforcement and legacy execution
compatibility, not the single-trusted-operator authentication model.

Actual Ubuntu 24.04 ARM64 checks used Node 22.23.3, Docker 29.8.1, the source snapshot at
`/home/developer/src/open-harness-desktop-sandbox-20260926`, and the already rebuilt,
pinned `open-harness-hermes:sandbox-20260926` image. No image source changed in this pass.

- `tests/real-desktop-smoke.mjs` now uses the production `ensureContainer` factory:
  real Chromium screenshot, coordinate click, accessibility-token click and typing
  verified by DOM readback; stale-token refusal; two agents' separate X11/D-Bus desktop
  sessions and windows; host/other-agent private sentinel denial; own credential access;
  Shared read/write; private-desktop restart; disabling desktop access replaces the
  container and removes its display while preserving private files. Evidence:
  `/tmp/open-harness-desktop-smoke-byhrfI/evidence.json`.
- The real filesystem sandbox gate still passes all eight check groups, including kernel
  limits and folder-grant revocation. Evidence:
  `/tmp/open-harness-sandbox-XoPa0o/evidence.json`.
- The real pinned Hermes gateway passes file, clarification, task MCP, context continuity,
  denied/approved terminal actions, and cleanup with a scripted provider. Evidence:
  `/tmp/open-harness-real-smoke-6rbP5t/evidence.json`.
- The actual standalone installed Linux runner passes pairing, user service, encrypted
  credential dispatch/rotation, transfer, remote file/input/MCP/memory/skills, restart,
  event replay, revocation and cleanup. Evidence:
  `/tmp/open-harness-runner-smoke-YUkS6p/evidence.json`.

Runtime Node tests: 165/165, including legacy native-process recovery, rejection before
spawn, blocked old-runner capabilities and persisted commands, direct runner rejection,
and safe staging of legacy-profile conversion to a remote sandbox. The final combined
tree passes typecheck, full lint, production build and all 94 desktop/mobile browser
cases on Ubuntu ARM64. Claude independently passes the same Node165/browser94 gates on
Ubuntu x86-64. The seven delivered UI files match Claude's SHA-256 hashes; all 160 files
in the final source snapshot match the Ubuntu checkout.

Computer settings are available without Advanced features. The UI offers a private
agent desktop only on a capable Linux machine, explains unsupported machines, and
preserves legacy settings until explicit conversion. Desktop control remains a separate
tool grant: the browser acceptance enables it through the guidance beside the desktop
switch and verifies both saved settings. No permission is granted automatically.

Evidence, screenshots and final logs are collected locally in
`/private/tmp/open-harness-desktop-sandbox-evidence-20260926.tar.gz`; the source snapshot
and manifest are `/private/tmp/open-harness-desktop-sandbox-source-20260926.tar.gz` and
`/private/tmp/open-harness-desktop-sandbox-source-20260926.tar.sha256.json`.
All fixture containers and the temporary installed-runner service were removed.
These scripted fixtures verify enforcement and transport, not model reasoning or paid
provider behavior. macOS/Windows host-desktop isolation is not offered or claimed.

## Per-agent sandbox follow-up — September 26, 2026

Checked the current working tree with Claude's delivered UI in place. The requested
boundary keeps Shared files available to all agents while isolating private files and
ungranted host paths. Validation used a separate Ubuntu 24.04 ARM64 checkout at
`/home/developer/src/open-harness-sandbox-20260926`, Node 22.23.3 and Docker 29.8.1.
`npm run harness:setup` rebuilt the pinned runtime under the separate
`open-harness-hermes:sandbox-20260926` tag; existing installation images were preserved.

Fixed host-side profile temporary writes that could follow agent-planted links, hardened
workspace imports/uploads and file previews (including a link swap at open time), and
regenerated the standalone runner. Both sandboxed access modes now require Docker in
readiness and transfer validation. Folder mounts reject files, sockets and linked paths
before replacing a container. These are container-boundary and host-file-access changes;
At this earlier checkpoint Direct Computer Access remained an explicit unsandboxed mode; the subsequent computer-control follow-up above disables it.

The new `tests/real-sandbox-smoke.mjs` passed eight groups of checks with real production
containers and no model calls: separate private/profile mounts and selected credentials;
refusal of individual files, Unix sockets and links planted by an agent as folder grants;
intentional shared read/write files; non-root UID, zero effective capabilities, seccomp,
no-new-privileges and kernel CPU/memory/PID limits; immutable managed policy; resistance
to profile temporary-link writes; read-only/read-write folder enforcement; replacement
and mount revocation on return to Private workspace; and shutdown cleanup. Related checks
share groups. No agent received a Docker socket or could see the host sentinel or the
other agent's private paths. The real sandbox smoke is included in the runtime CI workflow.

The final Node suite passes **163/163**, with typecheck, full lint, production build and
diff checks passing. The unchanged UI passes **86/86** desktop/mobile browser cases with
the mock runtime. The rebuilt image also passes the real Hermes gateway smoke: allowed
file tools, denied Terminal dispatch, clarification, authenticated task MCP, distinct
sessions, prior context, explicit approval deny/approve and container shutdown. No paid
provider was used. Test containers were removed by their exact IDs.

Evidence: `/tmp/open-harness-sandbox-l9ASyy/evidence.json` and
`/tmp/open-harness-real-smoke-b4GgFl/evidence.json` on the VM, plus
`/private/tmp/open-harness-sandbox-evidence-20260926.tar.gz` locally. This establishes the
tested Linux filesystem/process boundary, not a kernel security certification or new
macOS/Windows Docker acceptance. Shared files and outbound networking (including reachable
host services) remain available. Saved permissions apply to the next task; stop active
work first when tightening access must be immediate. See `SECURITY.md` for these limits.

## Recent-commit integration — September 25, 2026

This pass starts at `main@3415d71` on `codex/recent-commit-integration`. It keeps the
new saved Credentials, teams/projects, canonical MCP tool names, encrypted runner dispatch,
Hermes pin and approval protocol. Removed hosted/native-mobile surfaces stay removed.
Earlier acceptance on the separate `codex/mvp-readiness` branch is not evidence for this tree.
The VM uses the isolated image tag `open-harness-hermes:integration-20260925`; its existing
default image is preserved. Updated installations must prepare runtime contract 3.

Validation ran on the separate Ubuntu 24.04 ARM64 VM with Node 22 and Docker, using isolated
source checkouts and disposable state. The untouched incoming tree passed 111 Node tests,
52 browser tests, typecheck, lint and build; new regression cases then exposed failures that
those suites did not cover. The integrated backend passes 158 Node tests, typecheck, full lint
and production build. Workflow actionlint, shell/Python syntax and diff checks also pass.
With the UI patch applied (below), the same tree also passes 86 production browser cases.

Current real integration evidence uses the pinned Hermes runtime and scripted local
OpenAI-compatible providers. No paid provider was called during this pass; these results
establish tool/transport/state behavior, not model reasoning:

- **Actual Docker gateway:** file tools, clarification, canonical task-board MCP dispatch,
  denied tools, distinct session IDs and prior-conversation context work. An explicitly manual
  approval test denies and then approves a flagged chmod; the file stays 0600 until approval,
  then changes to 0666. At that historical checkpoint, the shipped `smart` guardian policy remained unchanged; the October 3 decision below restores `manual`.
- **Cold production Compose:** fresh private engine storage starts without a Hermes image;
  setup builds runtime contract 3 through the dashboard proxy in 227846 ms. The coordinator
  and data run as UID 1000. Saved credentials authenticate actual requests, rotate between runs
  and preserve metadata. Team-scoped tasks, file/input/context/history, restart persistence
  and graceful shutdown pass. The engine has no TCP listener. Actual nested agents cannot
  reach dashboard bootstrap through its container address or published port, even with a
  loopback Host header. Production CSP and forged-Host checks pass.
- **Installed runner:** the downloaded standalone runner and its Node runtime run as a
  disposable Linux user service. Encrypted command delivery, credential authentication and
  rotation, remote memory/skill edits and tool reads, transfer, sessions, replay, restart and
  revocation pass. The installer persists the selected image and replaces stale contracts.
- **Persistent workflows:** Hermes writes canonical memory and a skill, then reads both in a
  new session and after a coordinator restart. Shared-team named delegation returns the child
  artifact/result. A persisted one-minute routine dispatches on its timer after restart.
- **Private virtual desktop:** actual Chromium navigation, accessibility snapshots, PNG
  screenshots, window capture, pixel/AX clicks with confirmed DOM effects, typing, stale-token
  refusal and restart pass with pinned CUA 0.28.2. This is the container's virtual desktop,
  not host-native Direct Computer Access.
- **Container ownership:** admission and crash recovery verify state ownership before reuse, replacement or stop. Same-name agents in separate workspaces get distinct container names, and long IDs retain distinct names and profile paths; legacy containers are adopted only when their private mounts prove ownership. Cleanup failures exit nonzero. The final actual gateway/approval gate passed after these checks were added.
- **Runtime updates:** full images write a contract marker. A policy-only rebuild succeeds on
  that base and refuses an old markerless image instead of relabeling outdated dependencies.

The tested UI/client patch under `work/current-ui-review/` **was applied to the shared
checkout by the UI owner on September 25 at 17:45 MDT**, on the user's explicit instruction
and under the ownership protocol. Before anything ran, all nine shared originals matched
`original-hashes.json`, the patch matched the SHA-256 in `checks.json`, `git apply --check`
was clean, and all eleven results matched `updated-hashes.json` byte for byte. Three new
regressions had first failed on unchanged main: a rejected model draft overwrote workspace
settings, inherited credentials filtered by the wrong provider, and long setup requests used
the ordinary 30-second deadline. The patch also covers clarification replies, concurrent
conversations and complete history/event recovery.

The applied tree was then validated on Linux (Ubuntu 24.04 x86-64 sandbox, Node 22.22.2,
Playwright 1.63.0 with its Chromium): 158/158 Node tests, typecheck, full lint, the production
build, and `npm run test:browser` **86/86** desktop+mobile cases — three consecutive full
runs, two of them under concurrent CPU load from the Node suite. That load surfaced three
races the reviewed candidate did not cover, fixed in UI-owned files and covered by the suite:
Workspace settings compared the form against a snapshot taken when the dialog opened, so the
coordinator's model import landing afterwards flagged an untouched form as edited (a spurious
"Discard unsaved settings?") and overwrote an edit in progress — the baseline now tracks the
saved model, a late import keeps an in-progress edit, and Discard restores the saved values;
the workspace was only written to browser storage 800 ms after its last change, so leaving
during a streaming run lost that conversation locally until the coordinator rebuilt it — it
is now also flushed on `pagehide`; and the task label field re-rendered its parsed labels and
swallowed each comma as it was typed, a fix lost in the 0.4.0 rebase — it now keeps what is
typed, with the regression carried into `integration-regressions.spec.ts`. The legacy-reply
recovery spec seeds storage from a one-shot init script so the previous document's pending
save cannot land on top of the seed. Twelve files were delivered (the eleven patch paths plus
`components/task-manager.tsx`); every one was re-read from the shared folder and matched its
SHA-256, recorded in `work/current-ui-review/checks.json` under `applied`. Docker-backed and
paid-provider checks were not part of this UI validation.

Evidence is retained on the VM under `/home/developer/open-harness-evidence/` and in local
`/private/tmp/open-harness-integration-{root,docker,runner}-evidence-20260925.tar.gz` archives.
The opt-in scripts are `tests/{real-hermes,compose,real-runner,real-desktop,real-workflows}-smoke.mjs`;
`.github/workflows/runtime.yml` runs the container/Compose/workflow/desktop gates in CI. The
installed-runner gate intentionally requires a disposable Linux user session. Test resources
are cleaned up by their exact IDs/projects; no global Docker prune is used.

Packaged-release acceptance, image vulnerability scans, backup/restore and soak testing,
paid-provider reasoning, third-party MCP servers, host-native desktop access and signed
macOS/Windows installers are separate gates and are not claimed here. The Intel release job
now uses `macos-15-intel`, following the [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The entries below are historical reports with their original scope and limitations.

## Public beta release-candidate implementation pass — September 24, 2026

Implemented and verified without paid inference:

- The production dashboard now exposes `/api/health`, which returns only coordinator reachability. Compose uses it for the service healthcheck, passes the remote-dashboard trust switch explicitly, and gives the coordinator up to 25 seconds for cleanup during shutdown.
- Remote bootstrap remains denied by default and is allowed only when `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`; both paths have route coverage.
- First-run setup no longer records completion when dismissed, when runtime preparation is incomplete, or after a failed model test. Failed connection tests preserve the saved revision and can be retried.
- Teams, boards, routines, remote computers, direct access, and MCP configuration are hidden behind a local Advanced features preference that defaults off. Existing data and APIs are unchanged.
- Browser hydration no longer describes a persistent run as interrupted merely because its tab was closed; the coordinator remains authoritative and replay supplies the current state after reconnect.
- Pending approvals are rebuilt from durable run events after reconnect, including when the saved event cursor has already passed the approval request. The mobile workspace panel now starts closed so it cannot cover task and approval controls.
- Self-hosting documentation now covers authenticated HTTPS proxying with streaming, health checks, updates, diagnostics, and stopped-stack backup and restore.
- Every reported version is `0.4.0-beta.1`. Self-hosted release publication is separate from signed desktop packaging, rejects tags that do not match the reviewed `main` commit and package version, and depends on tests, browser coverage, a fresh Compose health smoke test, coordinator/Hermes builds, and high/critical image scans.
- The source-release builder archives the reviewed Git tree with the lockfile, Compose files, runtime Dockerfile, and operations documentation; it rejects local state, environment files, dependencies, and build/test output. The publishing job adds SHA-256 checksums.

Checks: 97 Node tests, 46 Playwright desktop/mobile tests, TypeScript, ESLint, the production Vinext build, Cargo manifest/lock metadata, workflow YAML parsing, `git diff --check`, and `docker compose config` passed. Browser coverage includes incomplete setup, failed model retry, advanced-feature visibility, agent creation, task submission, pending-approval reconnect, and exact file download. `npm audit --omit=dev` reported 0 known vulnerabilities across 126 production dependencies.

Live release acceptance remains blocked on this machine: its selected Docker Desktop socket does not exist, the system Docker socket is not accessible, and `.env` has no configured model credential. Therefore the full coordinator/Hermes builds and Trivy scans, fresh Compose smoke test, authenticated proxy test, real-provider `launch-smoke.md` workflow, process-tree termination, upgrade/restore comparison, and 24-hour soak are not claimed as passed. The release tag and GitHub Release must not be created until those gates and the repository-rule checklist in `docs/BETA_RELEASE.md` are complete.

## Fourth real-runtime pass — September 25, 2026

Named handoffs, task boards, scheduled routines and the approval round trip, against the same
paid provider as the third pass (OpenRouter, `meta-llama/llama-3.3-70b-instruct`), on Linux with
Docker Desktop 29.5.3 and the pinned image `open-harness-hermes:2026.9.11`. Two container agents
on a shared team, in a state directory holding one credential, on port 4401. Inference spend for
the pass: $0.034.

**Every coordination tool was unreachable, for four separate reasons at once.** Each one alone was
enough to make the whole feature silently absent, and the mocked suite could not see any of them.

1. **Tool names.** Hermes registers an MCP tool as `mcp__<server>__<tool>`; Open Harness granted
   `mcp_open_harness_task`. The managed policy extension matches a granted name against the
   registry name exactly, so it stripped every coordination tool from every request. The agent was
   told the tools did not exist. The same mismatch removed all tools from any user MCP connection.
2. **A stale copy in the image.** The image bakes its own `coordination.mjs`, and the pinned one
   predates the `task` tool: the container advertised two tools where the checkout has three, so
   task boards could not work even once the names matched. The checkout's copy is now placed in
   the agent's managed directory, which the container already mounts read-only.
3. **Tool Search.** Hermes defers MCP tools out of the model-facing array and offers
   `tool_search`/`tool_describe`/`tool_call` bridges instead. Those bridges are not tools an Open
   Harness profile grants, so the policy stripped them too, leaving the deferred tools reachable by
   neither route. Deferral is now off for managed agents; a profile grant is already a short
   explicit allow-list.
4. **`http.request(options, options, callback)`.** `coordination.mjs` passed an options object
   where node expects the response listener, so every call over the unix socket — the route every
   local container agent uses — failed with "The listener argument must be of type function". The
   existing socket test drove the socket with node's own client, and the existing coordination test
   drove `coordination.mjs` over a URL; nothing drove `coordination.mjs` over a socket.

**And the socket cannot work on this setup at all.** Docker Desktop passes bind mounts through a
VM: `coord.sock` is visible inside the container and refuses every connection (`ECONNREFUSED`,
mount type `fakeowner`), while connecting from the host succeeds. ROADMAP recorded this as a
macOS/Windows blocker; it applies just as much to Linux with Docker Desktop, which is the install
this project documents as supported. The socket is still tried first — it needs no open port and
cannot be reached from off the machine — with `http://host.docker.internal:<port>` behind it, the
same fallback a paired runner already used for its own containers. Docker Desktop's host proxy
reaches the coordinator on loopback, so nothing had to be exposed: `--add-host
host.docker.internal:host-gateway` was already set, and the container still needs the run's token.

Two more defects came out of driving the board from a live agent:

5. **The container signature left out the state root** the mounts are built from. Pointing
   `OPEN_HARNESS_STATE_DIR` at a new directory reused the existing container with its mounts still
   on the old path; Docker recreated that path as an empty directory, so the agent started with no
   `config.yaml`, the policy extension never registered, and the run died with "Hermes gateway
   exited during startup" over a log line telling the operator to rebuild the image. Restoring a
   backup to a different path, which `docs/SELF_HOSTING.md` documents, hits exactly this.
6. **The task tool's schema did not say where an action's fields go.** They nest under `input`, and
   a model that sent `stageId` beside `action` — the obvious reading — got "Stage is required."
   with no hint. The schema now documents the shape per action and the route accepts either
   spelling, plus an `input` sent as a JSON string, which would previously have been spread into
   one key per character.

Verified after those fixes:

- **A board task reaches Review.** A task assigned to Beta in the app moved to the Review stage by
  Beta's own `action: "move"` call, with the stage id it had read from the same tool.
- **Named handoff.** Alpha called `mcp__open_harness__delegate_named_agent` with Beta's id; the
  coordinator recorded `handoff.created`, created a child run for Beta in its own container, and
  recorded `handoff.completed` with its state. Beta wrote `handoff.md` to the shared workspace with
  exactly the requested contents, and the parent received the child's result.
- **Task board.** With a task assigned to Beta in the app, Beta called `mcp__open_harness__task`
  with `action: "list"` and replied with the task's exact title.
- **Scheduled routine.** A one-minute routine created in the app fired on the scheduler's next
  tick, its run completed with the requested output, `last_run_at` was recorded and `next_run_at`
  advanced by exactly one interval.

**The approval round trip was broken in two further ways, and is now verified in both
directions.** Hermes offers an approval channel only when it can see one: with neither
`HERMES_GATEWAY_SESSION` nor a bound session platform, `tools/approval_context.py` finds no
interactive context, no gateway context and no unattended context either, and approves every
flagged command outright. So the dashboard's approval UI and the configured
`approvals.unattended_mode: deny` did nothing on a real run, and a container agent ran `chmod 777`
against a bind-mounted host file with nobody asked. The managed gateway now announces itself.
Second, Hermes reads the decision from `choice` and accepts `once`/`session`/`always`/`deny`;
Open Harness sent `decision: "approve"`, so Hermes read every approval as a refusal — the operator
pressed Approve and the agent was told the user had blocked the command. The deterministic runtime
accepted `"approve"` too, which is exactly why this survived. Evidence, with a real before and
after: a run paused in `waiting_approval` carrying the real command and its
`world/other-writable permissions` finding; approving took the file from 644 to 777 and the agent
reported it "was approved by the user"; denying left it at 644 and stopped the command. The gate
was forced to `manual` for that pair of runs only; `smart` remained the default at that historical checkpoint. The October 3 decision below restores `manual` in shipped configuration.

**Decision resolved October 3, 2026.** At the time of this check, `approvals.mode: 'smart'`
sent flagged commands to an auxiliary guardian model; it silently approved `chmod 777`
on a bind-mounted host file and used the operator's provider key for that decision.
The user selected `manual` for the public beta. Commit `81a41a8` restores manual
approval in generated profiles and the bundled runner, so Hermes-flagged commands
reach the operator's approval flow. Unattended and scheduled approvals remain denied.
Manual mode does not request approval for every command; Hermes still decides which
commands to flag. This policy change is not a new real-container acceptance result.

Also confirmed incidentally: `POST /v1/onboarding/status` correctly refused a state directory that
Docker cannot read (the probe named the real cause and pointed at the fix), and all five readiness
checks passed once the directory moved under `$HOME`.

**`runtime/hermes/Dockerfile` builds from scratch**, for the first time: earlier passes could only
patch the existing image because a full build did not fit on the root disk. The result carries
`dev.openharness.runtime=2`, imports the policy extension, and serves all three coordination
tools. Built under a throwaway tag and removed afterwards, so the pinned image is untouched.

Still not exercised live: real third-party MCP servers, Direct Computer Access, native subagent
restrictions, a Compose install from a packaged source release, and a backup and restore cycle.

## Third real-runtime pass — September 25, 2026

First end-to-end pass against a **paid provider**, on Linux with Docker Desktop 29.5.3,
Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`. Provider: OpenRouter,
model `meta-llama/llama-3.3-70b-instruct`. Total inference spend for the whole pass: $0.0054.

Run from a fresh state directory holding only one credential, on port 4399, so nothing
touched the operator's own workspace. Verified in order:

- **Readiness.** All five checks report ready, including the Docker bind-mount probe for the
  state directory.
- **Credential to provider.** `POST /v1/onboarding/model-test` authenticates against
  `https://openrouter.ai/api/v1/models` with the stored key and reports ready.
- **A real task that changes the workspace.** A run asking the agent to write a file
  completed, and `live-check.md` arrived on the host in `shared/` with exactly the requested
  contents. `GET /v1/files?scope=shared` lists it.
- **Event replay.** 26 durable events for that run, including the full tool lifecycle
  (`tool.generating` → `tool.start` → `tool.complete`) carrying the real `write_file`
  arguments, replayable from `?after=0`.
- **Filesystem isolation.** The container has exactly four mounts — `shared` read-write,
  the agent's own `private` read-write, its profile home read-write, and `managed`
  read-only. Inside it: the host home is not present, `/var/run/docker.sock` is not present,
  no other agent's private directory is reachable, `/run/open-harness` is genuinely
  read-only, and the process runs as `1000:1000` rather than root.
- **Process-tree termination.** With `managed_entry.py`, a Hermes terminal wrapper and a
  `sleep 400` child all running inside the container, `POST /v1/runs/:id/stop` returned
  `{"ok":true,"stopped":1}`, the run became `cancelled`, and the container exited 143 —
  taking the whole tree with it. No agent process survived on the host.
- **Crash recovery.** `SIGKILL` to the coordinator mid-run, then restart: the run is
  `interrupted` with the "not replayed" reason, its 17 events are preserved, the stored
  credential is intact, and the control token is unchanged.
- **Container reaping.** The hard kill left a container that the `--restart unless-stopped`
  policy brought back with no gateway owning it. The next clean shutdown logged
  "Stopped 1 agent container" and stopped it. The operator's separate Docker Compose stack,
  running at the same time, was untouched — the reaper matches on the managed label, not on
  the shared `open-harness-` name prefix.

This pass found one defect that no mocked test could see, now fixed: a new agent was granted
only `mcp_open_harness_task`, so the first thing anyone asked it to do it truthfully refused,
saying it could not create files. `DEFAULT_TOOLS` in `lib/agent-profile.ts` now grants the
working set — files, terminal, code execution, memory, session recall, skills, web and
clarify — while desktop control, delegation, scheduling and MCP connectors stay off.

Still not exercised live: real MCP servers, Direct Computer Access, native subagent
restrictions, named-agent handoff, scheduled routines, an approval round trip, a
from-scratch build of `runtime/hermes/Dockerfile`, and the broader code-repair and browsing
scenarios.

## Real-runtime pass — September 21, 2026

First execution against the real, non-mocked runtime (`mode: live`), on Linux with
Docker Desktop 29.5.3, Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`.

A local OpenAI-compatible server stood in for a paid provider, so this exercises the
whole path — credential storage, profile preparation, the bind-mounted profile, plugin
discovery, gateway startup, model resolution and outbound authentication — without
billing a real key. No paid model calls were made.

Verified, from a fresh state directory and a container created from the image:

- A credential created through `POST /v1/credentials` is stored, fingerprinted, and
  written into the agent profile `.env` and nowhere else.
- `prepareProfile` writes `config.yaml`, `SOUL.md` and `.env`, and the agent container
  reads all three from the bind mount.
- The managed policy extension loads and registers, so `managed_entry.py` starts the
  gateway rather than aborting.
- `session.create` returns a session bound to the configured model.
- A run submitted through `POST /v1/runs` reaches `completed`, streams
  `message.start` → `message.delta` → `message.complete`, and the model's response
  propagates back as the run result.
- The outbound request to the model endpoint carries the configured credential.

This pass found four defects that the mocked suite could not see; all four are fixed
in commit `603b19b` and covered by `tests/managed-runtime-contract.test.ts`:

1. `plugins.enabled` was written in a shape Hermes reads as "nothing enabled", gating
   the policy extension off and killing every containerized run at gateway startup.
2. The extension entry point resolved to a function rather than a module, so Hermes
   found no `register()`.
3. A custom or local endpoint had its credential aliased to `OPENAI_API_KEY`, which
   Hermes refuses to send to a non-OpenAI host, so it sent `no-key-required`.
4. Docker Desktop bind-mounts only shared host paths; any other path mounts as an empty
   directory with no error, so the agent profile never arrived. The default state
   directory hits this whenever the checkout lives outside the shared roots. This is now
   probed per state root and reported with its real cause.

## Second real-runtime pass — September 21–22, 2026

Same setup as the first pass. Closed the gaps that pass left open; all evidence is from a
coordinator in `mode: live` unless noted.

- **Runtime contract.** The image now carries `dev.openharness.runtime` and readiness
  compares it with `RUNTIME_CONTRACT`. With an older-contract image under the pinned tag,
  `harness doctor` reports "Update agent runtime", `executionReady: false`, exit 1, and a
  run is refused with that cause instead of starting a container that dies at gateway
  startup. With the current image restored: ready, exit 0, run completes.
- **Container recreation.** The container signature includes the image ID. After retagging
  a rebuilt image (new ID, same contract) the next run recreated the container (`.Image`
  changed, newer `Created`), then completed.
- **First-party providers**, offline inside the image via Hermes's own resolver:
  `xai` and `openrouter` resolve the key from the profile `.env`. Hermes has no provider
  called `openai`; Open Harness now writes `openai-api`, which resolves `OPENAI_API_KEY`.
- **Explicit endpoint on a first-party provider.** Hermes ignores `base_url` on its native
  providers (a proxy for xAI still resolved to `api.x.ai`), so any explicit endpoint now
  takes the custom path. Hermes also refuses to hand a native provider's variable to a
  custom endpoint, so the credential is written under `OPEN_HARNESS_MODEL_API_KEY` and
  `key_env` names that. Live run: provider `xai`, credential saved as `XAI_API_KEY`,
  endpoint set to the local server — the request arrived as `Bearer xai-PROXY-…`.
  (The offline resolver reports a placeholder for this path even on a copy of a profile
  that provably sent the key; treat the gateway run as authoritative for custom endpoints.)
- **State directory.** `harness setup` on a simulated fresh checkout on the unshared drive
  chose `~/.open-harness/<project>`, recorded it in `.env`, and stayed silent on the next
  run; on this checkout, which already holds state, it changed nothing.
- **Cheap rebuilds.** `runtime/hermes/Dockerfile` now installs Open Harness files after the
  upstream layers and passes `docker build --check`. It was **not** built end to end on
  this machine: a from-scratch build does not fit on the root disk. The labeled image was
  produced with `runtime/hermes/extension/Dockerfile.patch`, which shares the label.
- Suites: 93 node tests, Playwright 36/36 desktop+mobile, `tsc`, `eslint`, `vinext build`.

## Still pending

Superseded by the two September 25 passes above, which covered paid-provider inference,
filesystem isolation, process-tree termination, crash recovery, named-agent teamwork, task
boards, scheduled runs and approvals. Still not exercised against a real runtime: real
third-party MCP servers, Direct Computer Access, native subagent restrictions, a full
from-scratch build of the reordered Dockerfile, and the broader code-repair, browsing and
durable skill-use scenarios.

The deterministic control and browser suites still run under `OPEN_HARNESS_MOCK=1` and
do not by themselves establish live acceptance.

## Agent profile upgrade verification — September 14, 2026

Verified with Node 22 and the pinned Hermes source interface (`v2026.9.11`,
`939e45c91d751fadd94dcd1b873ac3cb44846213`).

- `npm test`, including persistent profile revisions, independent model overrides,
  inheritance, stale saves, next-task snapshots, explicit empty grants, credential
  separation, MCP inventory retention, stream completion, provider errors, and scoped
  Unix coordination sockets.
- Seven Python policy tests for allowed and denied dispatch, nested code-tool dispatch,
  model schema filtering, forced disabled choices, and fail-closed behaviour.
- Playwright across desktop and mobile, covering the editor tabs, Save/Cancel, prompt
  switches, tool grants, inline MCP configuration, failed-save retry, reload
  persistence, stale-save recovery and keyboard navigation.
- `npm run lint`, `npm run typecheck`, `npm run build` and `git diff --check`: passed.


## Independent integrated-change review — September 26, 2026

A fresh isolated Ubuntu ARM64 review used Node 22.23.3 and Docker 29.8.1. Captured
source passed 162 Node tests, typecheck and full lint. The production build and
86 desktop/mobile browser cases passed on an earlier phase with identical UI source.
Actual pinned Hermes container acceptance passed clarification, task MCP, context,
tool policy, manual approval denial/approval and cleanup; the supplemental actual
sandbox gate passed eight checks, including folder access and revocation. These
checks used scripted local providers or no model calls, not paid inference.

Two additional reproductions found remaining integration defects: model validation
can outlast the client's 30-second deadline and commit after the UI reports failure;
and a run finishing between the bootstrap history and run-list reads can leave an
empty reply with no follower. No application fixes were made by this review.

The shared checkout changed during verification. Runtime fixes and runner
regeneration were incorporated into successive snapshots. After the last passing
supplemental snapshot, further changes arrived in runtime/computer-validation.ts
and runtime/hermes.ts; those later bytes are not covered by this review's final
results. Exact manifests, source archives, reproducers, logs and the review are in
work/integration-review-20260926/. Two unreadable duplicate local filenames were
excluded and preserved. Compose, installed-runner, private-desktop and scheduled
workflow gates were not repeated; their earlier evidence retains its original scope.

## AMD64 component builds under Docker emulation — September 29, 2026

The Ubuntu runner was `linux/arm64` with Docker 29.8.1. Each controller bound a
`linux/amd64` builder image and the same read-only BuildKit QEMU executable
(`5e3eb921f26f576b3722207bbf5a192ba099032924eb7d0f4104bb1b536e5f51`).
This is **emulated**, not native AMD64 hardware evidence. No host `binfmt_misc` change
or production coordinator change was needed.

- Buildx bootstrap, materialization and build passed. Its static AMD64
  `docker-buildx` is SHA-256 `55f460cfd9bdd65330f4cb5fea7b293a9418038a52402f0886bcfc8e0e4c8ab4`;
  source manifest `e2f4e5ee6ef1f7e3433a20bdd346b0f64010162cefef5b564e543698b10ebd39`.
  A restricted QEMU `version` invocation exited successfully.
- runc bootstrap, materialization and build passed after independent review of
  the AMD64 builder's 11 static-library inputs. Its static AMD64 `runc` is
  `5ddf7779298382db320f387e31b09e27cb495726ef1804efff1e1f99b651ba3a`;
  source manifest `0a24344a0784326097114431c010cc9100bc00ef6ec9d1d3e1c5573c4fabe010`.
  A restricted QEMU `--version` invocation exited successfully.
- The AMD64 containerd builder image was built from the pinned Ubuntu base and
  inspected as `sha256:0510a2a0a2eb7b7a753f026eab2cdd880c32f18db553f5682e8b07c1c93e258a`,
  user `1000:1000`. Containerd bootstrap, materialization and build then passed.
  The materialized source manifest is
  `8ad2fa7546da1f82ef1f0f774c3f6c7aaddbe9f0704a0324b820474c42de4645`;
  all 6,490 tracked-file checks, source commit/tree and source archive matched.
  The static AMD64 binaries are `containerd`
  `664a6ef40a9f608b950a7aec896001ec406d6a9c2a59886e2766fb4a4f4de770`,
  `ctr` `65d120f43ec4fcc7a79eddc5d183e7d5af124f95abaf04cec94cdefbfc6ada87`,
  and `containerd-shim-runc-v2`
  `5f8b2635e2f919327fc728206d15ee73991489d81b04633978c20fbbd4d03200`.
  Restricted read-only, network-disabled, non-root QEMU version invocations of
  all three exited 0 and reported the expected custom version. The controller
  removed its exact build container; no outer container remained.

The current source snapshot on Ubuntu Node 22 passed 254 Node tests, typecheck,
lint (zero errors, five warnings), build and 120 browser cases **with the
reviewed Debian-origin workflow patch applied only in an isolated copy**. The
actual protected workflow file has not received that patch, so its one Node
workflow guard still fails. The clean Ubuntu Python suite passed 134 tests with
30 expected skips after `test_curl_logging.py` gained its missing evidence-fixture
skip; both logging tests also passed when that fixture was supplied. Production
dependency audit found zero vulnerabilities at the configured high threshold,
and a source secret scan found none.

These results establish component builds and limited target execution. The
published AMD64 inputs image, final engine/coordinator/Hermes images, downloaded-package
acceptance, final-image backup/restore, 24-hour soak and publication remain open.
The component recipe's internal provenance calls its QEMU environment “native”
because it sees `x86_64`; the controller receipts above are authoritative about
the ARM64 host and emulation mode.

The AMD64 engine inputs were subsequently assembled as 107 files (322,379,966
file bytes). `check-engine-inputs` found no missing, extra, mismatched, unpinned
or wrongly moded files. Twenty-four architecture-independent upstream source
and license records matched the previously reviewed ARM64 inputs; the 25 AMD64
runc builder records matched the inspected builder image. A local `linux/amd64`
data image `sha256:76b89daf43730f23d3bd50ff8ba75c58287cf2d49cfd8fbadcfcc6e693c7829a`
was built without network access and its 107 image files were independently
checked against the lock. A verified `docker save` backup remains at
`Claude outputs/runtime-recovery-20260928/engine-amd64-inputs-local-image.tar.gz`
(SHA-256 `7e87595739f03494ea448a5212a7b7b4930a56687cf7a309a9233b80d2e14799`);
the local tag was removed after backup to preserve disk space. Its image ID is
not a published registry manifest digest, so the lock remains incomplete.

A local derived-engine rehearsal then built the unmodified production Dockerfile
(SHA-256 `722764869596d59eab2484db1318f585a19299725a83b2bd393d9886fa72098c`)
under pinned BuildKit emulation. Because the unpublished inputs image is not
visible to the separate BuildKit image store, this rehearsal substituted the
same 107 files through a named build context; the image's inputs label is
`ohinputs`, not a release digest. The resulting `linux/amd64` image is
`sha256:2b3025c4713628424f9486978fa699596474086f6748cd6f2b57ff252d004df4`.
Its Dockerfile verified all input hashes and modes, installed Expat 2.8.5-r0
offline, and installed the five rebuilt binaries. Independent readback matched
all five installed binary hashes and the three source manifests. Seven
read-only, network-disabled, non-root QEMU version/package invocations passed.
Trivy 0.74.0 with the September 29 database (`b15d9759…`) scanned this exact
image for HIGH/CRITICAL vulnerabilities and secrets: zero findings across ten
result groups. Scan JSON SHA-256 is `f819b2e4f082734ebec7b18ae57af393ef72e9e3dae275080fab57c41641d5b9`.

The first default-Docker-builder attempt stopped with `exec format error` at
the AMD64 `/bin/sh`; the pinned BuildKit builder executed it. A direct `FROM`
of the locally tagged inputs image then failed because that separate builder
tried to pull an unpublished name. One named-context attempt reached final
export but respected the 18 GiB disk stop floor. After archiving and retiring
only exact completed working trees and Go caches, a fresh attempt passed and
removed its BuildKit container. These attempts and the local image establish
engine assembly and CLI behavior, not a nested daemon, agent isolation, full
Compose run, final published-image scan or release acceptance.

The local engine image was also saved as
`Claude outputs/runtime-recovery-20260928/engine-amd64-local-rehearsal-image.tar.gz`
(SHA-256 `2478a350bd0b07e9e1eebffd12abc87a79c2966c5226691f1e1151a5ce3704bf`);
every OCI blob in that archive matched its digest. The completed containerd Go
caches and exact working trees retired for disk capacity have separately
verified backups (SHA-256 `372d181b2191838d1a2e14bdccc1ab746d3bcc2efea5c2fbefb9af35844fb2bf`
and `8470b335475299662a16a1bf6c6c69c829e4124a8bf42f42887aaa21b5b8cc96`).
The isolated Ubuntu Node 22 source snapshot with all 107 AMD64 input hashes in
the incomplete lock again passed 254 Node tests (three skips), typecheck, lint
(zero errors, five warnings), and build. That snapshot alone carries the
reviewed workflow patch; the actual checkout still fails its workflow guard.

## Local emulated AMD64 coordinator and Hermes gate — September 29, 2026

The Hermes Dockerfile now defaults to native builds and accepts an explicit
`OPEN_HARNESS_BUILD_MODE=emulated` only for an ARM64 BuildKit builder targeting
AMD64. The guard still requires AMD64 `dpkg` packages and an x86-64 machine view
inside every fetching/installing stage. The final image carries
`dev.openharness.build.mode`. The Ubuntu clean Python runtime suite passed 138
tests with 20 optional skips and no failures after this change; focused guard and
Dockerfile-policy suites also passed on macOS. The four changed source files
were copied to an isolated Ubuntu snapshot with byte-identical SHA-256 readback.

A pinned BuildKit builder (`moby/buildkit@sha256:5a8cd84c…`) built a local
`linux/amd64` coordinator from that snapshot and the previously reviewed 107-file
AMD64 engine-input context. The local image ID is
`sha256:66e8d65b5497b680a1ccf74f238481cb4f8d59507ede4d29dd7a433af4abf421`.
The production Dockerfile checked the derived Buildx SHA-256
`55f460cfd9bdd65330f4cb5fea7b293a9418038a52402f0886bcfc8e0e4c8ab4`;
restricted, network-disabled, read-only QEMU invocations checked Node 24.21.0,
Docker 29.8.1, the derived Buildx version, the installed Buildx hash and the
presence of bundled server files. Trivy 0.74.0 with the September 29 database
found zero HIGH/CRITICAL vulnerabilities and zero secrets across four result
groups in this exact image. The saved scan JSON is SHA-256
`a7c3ae9912b64f3ece240e2791bc28f4114aeeb3db2a377462e10327c743e731`;
the saved build log is SHA-256
`f4b90300fc248180f29872794083ea6e5153725274f07396d7d5451fa734db16`.
Both are under `Claude outputs/runtime-recovery-20260928/amd64-coordinator-local-v1/`.
This coordinator uses the local named context `ohinputs`, so its label is not a
published inputs-image digest and it is not a release image.

A separate BuildKit `build-inputs` target of the Hermes Dockerfile passed the
actual emulated guard and lock check as `linux/amd64`, image ID
`sha256:316fabf6f768f047daa897b0b1990a5f54de8eeefe360507157080f9d4e5b860`.
The full default-target AMD64 Hermes build ran under a 5,400-second limit and
an 18 GiB free-space stop floor. The curl distribution build and tests passed
after 3,222.8 seconds, and all 20 runtime stages completed. The final `verify`
stage failed closed at `check_packages.py`: the installed AMD64 set contained
two packages absent from the lock, `libdrm-intel1` `2.4.131-1` and
`libpciaccess0` `0.18.1-1ubuntu4.1`, both `amd64`. The build exited 1 before
exporting an image. Its exact BuildKit builder was removed successfully, no
outer containers remained, and the result recorded 30,334,939,136 free bytes.
The build log SHA-256 is
`7e10d3796be0a6f0760770cbcfc685ab0bafecbc8ab039c4fec40a4f12317b8f`;
the result JSON SHA-256 is
`ba1bb6e549cd9f1f1c02ac6c42a15828d363b8561842573580821abe163c62fc`.
Both and a checksum manifest are preserved under
`Claude outputs/runtime-recovery-20260928/hermes-amd64-verification-failure-v1/`.
Ubuntu's official package records corroborate both exact versions. The lock's
AMD64 package set was derived from ARM64; a reviewed AMD64-specific correction
and a complete rebuild are required. No Hermes AMD64 runtime image passed.

To make room for that build, the historical checkpoint
and prior ARM64 Hermes image were removed only after checking exact IDs, no
consuming containers, and complete OCI blob graphs in their saved archives.
The ARM64 Hermes archive is
`Claude outputs/runtime-recovery-20260928/hermes-arm64-image-backup-v1/portable-production-v1-mvirfy0e.tar`,
SHA-256 `b1d86a7244353f12fc3c99af90da21be63dbeb0dc4f49037905fff3a435a5cef`.
These actions do not establish a registry manifest, nested AMD64 engine startup,
clean browser install, final security gate or 24-hour soak.

Claude delivered an offline AMD64 application-image build and acceptance packet
under `Claude outputs/runtime-recovery-20260928/amd64-app-images-qemu-packet-v1/`.
Its original `SHA256SUMS` (SHA-256 `910e3502b2af28b3b58460621a0a2b76884bdcde6abd7fcbadd6e1455265c93c`)
and all 20 pinned source hashes passed independent readback. The packet's 21
fake tests passed on Ubuntu Python 3.12 when run as root; that test harness
uses a synthetic root-owned binfmt interpreter. The ordinary operator run
passed 19 and refused the two tests requiring that root-owned fake. Root-run
logs are retained in `Claude outputs/runtime-recovery-20260928/amd64-app-packet-independent-check-v1/`.
Those tests validate the controller logic, not the failed Hermes image or a
Docker/browser acceptance run. The packet's unchanged Compose fixtures still
need a reviewed transparent AMD64 execution handler or an AMD64 Docker host.

The reviewed AMD64 final-package correction packet is under
`Claude outputs/runtime-recovery-20260928/hermes-amd64-final-packages-review-v1/`.
Its `SHA256SUMS` is `a8a5926aa7527136a68f8d90320a1d1a9374321e9bcbb8837263c02593d75418`;
all ten payloads independently passed. The applied patch changes only the AMD64
final set from 329 to 331 by adding the exact two packages reported in the
hashed failed build log. ARM64's 329 entries and `check_packages.py` are unchanged.
The corrected lock is `50424767a819602aeda1c6676db89ee5f1811dc6ca87d7f3716ffb396a4269f0`;
the Dockerfile embeds that hash. Focused evidence-bound derivation and package
checks passed locally. An isolated Ubuntu Python 3.12 source snapshot passed
145 runtime tests, 21 optional evidence skips, no failures. After removing nine
macOS metadata files introduced by the transfer and fixing a test assertion to
look for the runtime-contract label specifically, that snapshot also passed
254 Node tests (three skips), typecheck, lint (zero errors, five prior warnings),
and build. The two new entries
are bound to an unsigned build log, not retained signed index records or `.deb`
hashes; a successful full image build is still required.

The first rebuild of that corrected source failed before package installation:
the live Ubuntu archive no longer offered pinned `openssl` `3.5.5-1ubuntu3.5`,
`libheif1` `1.21.2-3ubuntu0.5`, or `libheif-plugin-aomdec`
`1.21.2-3ubuntu0.5`. It exited 1, removed its exact builder and left no outer
containers or final image. Its build log SHA-256 is
`465ceb4d283e74732365abf7b616a2acdeb8010e5d87853b0155b85f0d2a0ecc`;
the copied evidence is under
`Claude outputs/runtime-recovery-20260928/hermes-amd64-snapshot-failure-v2/`.
No package pin was loosened.

An independent BuildKit QEMU probe used the official Ubuntu snapshot service at
`20260929T180000Z`. The bare Ubuntu image could not validate its HTTPS
certificate; installing the exact locked `ca-certificates` version from the
current signed archive fixed that bootstrap. Snapshot indexes then verified and
contained the three missing exact versions. Because the bootstrap upgraded
the OpenSSL library, CLI and legacy provider to `3.5.5-1ubuntu3.6`, the final
probe explicitly downgraded `libssl3t64`, `openssl` and
`openssl-provider-legacy` to the lock's `3.5.5-1ubuntu3.5` from the signed
snapshot and checked all three installed versions. A simulated install of all
203 unchanged OS pins then exited 0 and
selected exactly 203 new packages, including the two AMD64 additions. A plain
copy of the pinned Python image's CA bundle failed TLS verification in a
separate probe. The probe logs and their checked manifest are under
`Claude outputs/runtime-recovery-20260928/ubuntu-snapshot-probe-v1/` (`SHA256SUMS`
`6c1b160d4ec11fd79707641a3a99b3c8c4df197710799d9d786930cec9f849e6`).
The snapshot bootstrap is not yet integrated, and this simulated package
resolution is not a full runtime-image build or release acceptance.

The subsequent signed-snapshot patch packet is under
`Claude outputs/runtime-recovery-20260928/hermes-ubuntu-snapshot-pin-review-v1/`.
Its `SHA256SUMS` hash is
`23d31f203db2ca86a34fb468a7a25465ec8a20cca9f81e29d25acfd77cc2f9ed`;
all eight payloads passed independent readback. The patch adds
`runtime/ubuntu/helpers/ubuntu-snapshot.sh` to both APT stages and records the
fixed snapshot in the input lock. The helper first installs the exact pinned
CA package from the signed live Ubuntu archive, verifies that all later APT
indexes are from the signed snapshot, restores bootstrap changes to locked
versions, and rejects any unexpected installed package. A local portability
fix changed its repair count from `wc -l` to `awk`; the final helper SHA-256 is
`eae0ca31170212de82d5db7c3d6f32be4e6365ac389e5ba517bbf65b0ca59183`.
The final lock SHA-256 is
`fca5697674b3d2a7a9945982f2bb7d18e5374160eb479fb969bcb83f0892d491`.

The real helper, rather than the fake APT test harness, passed pinned BuildKit
QEMU probes on both Ubuntu bases. It restored exactly three OpenSSL packages to
their locked versions; the AMD64 simulation resolved all 203 OS pins and ARM64
all 201. The eight-payload probe archive is under
`Claude outputs/runtime-recovery-20260928/ubuntu-helper-real-probe-v1/`,
`SHA256SUMS` hash
`d72f09c5e9a27667a1c83e26a1a8f95ec181e9999b3375c5f024ccb6bf558662`.
The isolated Ubuntu Python 3.12 suite passed 158 tests, with 21 optional
evidence skips; focused local helper tests passed eight. After adding the new
helper to the coordinator's explicit installer route and both runner installer
lists, the Ubuntu Node 22 suite passed 254 tests, three skips, no failures;
typecheck, build and lint also passed, with zero lint errors and five prior
warnings. The full emulated AMD64 Hermes image build is still in progress, so
these checks do not establish a completed image or release acceptance.

On September 29, `npm audit --omit=dev --audit-level=high` against the
byte-identical `package-lock.json` in the isolated Ubuntu Node 22 source
snapshot exited 0 and reported zero vulnerabilities at all severities. The
lockfile SHA-256 is
`e8a47a65d23a05a6e019f83b132a5c400a1193ea5ff2c46a40a98e91034bfa93`;
the saved JSON report at
`/home/developer/.local/state/open-harness-verification/amd64-image-source-v1/npm-audit-final.json`
has SHA-256 `d7451ac771f98ed4058ce9693712d439757df8bca2be77355c4b9a6a48213f5f`.
The release verifier still stops before image building because the reviewed
AMD64 engine-input image has a local image ID, not a published registry
manifest digest. This is a release gate failure, not an accepted substitute.

The same isolated Ubuntu source passed the full mocked Playwright desktop and
mobile suite: 120/120 tests in 2.6 minutes. The run rebuilt the dashboard and
used local Chromium. Its saved log at
`/home/developer/.local/state/open-harness-verification/amd64-image-source-v1/browser-final-snapshot.log`
has SHA-256 `73c802e1e8d952671abf6e941151883c9c4ea8081e1663ca54a243993ff93820`.
This covers the browser UI and mocked coordinator, not the final container image
or clean-host install.

Claude's refreshed offline AMD64 QEMU application-image packet is under
`Claude outputs/runtime-recovery-20260928/amd64-app-images-qemu-packet-v2/`.
Its `SHA256SUMS` hash is
`e2d4f18b20b9182969a4ef7ec0bce52fd63a47629dc50d72d19dc3319e98fe12`;
all 17 payloads passed independent readback. The packet pins the current
Dockerfile, lock, snapshot helper, service route and both runner installers,
and its current-source static gate passed. Its 23 offline packet tests and 32
temporary-binfmt procedure checks passed. The procedure has not been run on
the host. The packet's existing build receipts require it to build Hermes
itself; the independently running v3 image cannot be substituted without a
separate reviewed adoption step. The offline tests are not AMD64 runtime
acceptance.

The v3 full emulated AMD64 Hermes build subsequently passed its real final
`verify` stage. It checked the exact AMD64 OS package set, curl HTTP/3, 90
native files and linkage, and recorded 48 Debian Chromium package files plus
two links. BuildKit completed the verified-runtime layer and generated OCI
manifest/config digests, but the controller's 18 GiB free-space guard canceled
the `--load` export while Docker imported the tarball. The lowest sampled free
space was 19,002,503,168 bytes, below 18 GiB. It exited 1, removed its exact
builder, and left no outer containers or loaded final image. The original
log, result, intent and builder-create output are preserved in
`Claude outputs/runtime-recovery-20260928/hermes-amd64-export-floor-v3/`;
its verified four-payload `SHA256SUMS` hash is
`1ea8bbb4eb31ad70cafcf34bacb93f2076cc1fdea79df94fb642734f778de4f1`.
This is a successful build-time verification with a failed image export, not
an accepted image or security scan. An exact-source v4 retry used the Docker
tar exporter under the same 18 GiB guard. It also passed the final exact
package set, curl runtime, 90 AMD64 native files and linkage, and Debian
browser inventory (48 files, two links), but the export was canceled when
free space reached 19,245,359,104 bytes, below the 19,327,352,832-byte
floor. No tar, metadata receipt, loaded final image or outer container
remained; its exact builder was removed. The four failure files were copied
and independently hash-checked under
`Claude outputs/runtime-recovery-20260928/hermes-amd64-export-floor-v4/`
(`evidence.tar` SHA-256
`4544f807459ba21bffcdd74d447c9a74ae06df96ae5b2d7cbcc44e8217d3809d`).
This demonstrates that tar export alone does not provide enough disk headroom.

Two inactive Trivy database caches were copied to the shared volume as tar
archives, extracted, and checked against their three original file hashes;
the source hashes were rechecked before removing only those runner copies.
The backup directories are `Claude outputs/runtime-recovery-20260928/`
`trivy-old-cache-backup-v1/` and `trivy-production-cache-temporary-backup-v1/`.
The production cache must be restored and rechecked before image scanning.
With about 30 GiB free, the same pinned v4 controller has started a new
attempt, `hermes-amd64-local-build-v4-c43g3wj2`; it has no result yet.

The offline v4 tar-export adoption addendum is under
`Claude outputs/runtime-recovery-20260928/amd64-app-images-qemu-packet-v2-hermes-adoption-v2/`.
Its `SHA256SUMS` hash is
`e647b523593a514e8c11833370a0aeca2a41668c128ccadfef5751cdf2881bf2`;
all 21 payloads passed independent readback, and its current-source static
gate passed locally. The 29 offline tests and 32 handler-procedure checks
passed in the packet. The addendum requires a successful v4 tar-export receipt,
matching metadata and verified archive contents, a separately loaded immutable
AMD64 image ID, and the packet's unchanged image, smoke, scan and acceptance
gates. It has not adopted an image. Its archive-layout reader awaits a real v4
tarball and must fail closed if the export differs from its test fixture.

The next v4 tar-export attempt succeeded with the same pinned source and 18 GiB
guard. It passed the complete Dockerfile verification and exported a
2,728,613,888-byte OCI archive (SHA-256
`a09ea882e31b241db34ed42f2aff2b432bf708340973c9c9fd99734ec37ed037`).
Independent archive blob, manifest, layer, config, and loaded-image checks
bound it to `open-harness-hermes:amd64-local-v4`, image ID
`sha256:88cfa852e05a7aa7feb6455b645a6fff4118bb99f57a1499b36897e5bfd06bfb`.
The Mac copy and build receipts are in
`Claude outputs/runtime-recovery-20260928/hermes-amd64-local-v4-success/`.
The restored production Trivy database retained SHA-256
`b15d975972da97057af64f60a1027191064932d6c90fd7e22631b7295bc038fe`.

The packet's first Hermes verification refused a retained libjpeg archive
because apt percent-encodes the version epoch in the local filename. Claude's
narrow correction in
`Claude outputs/runtime-recovery-20260928/amd64-app-images-qemu-packet-v2-debian-archive-names-v1/`
has `SHA256SUMS` hash
`7f8c02342cb2c86139c1da9a22dc27d129aa9864d25e315a63a70d579e76db25`;
all 30 payloads passed independent readback, 36 offline Python 3.12 tests and
32 handler checks passed on Ubuntu. The corrected `verify-hermes-2` passed on
the exact adopted image. The matching AMD64 coordinator image ID is
`sha256:44f975fa9bd8a978f1685398ed6890391927b5e9a13f5c291b7a93d3b554176a`;
its build, verify, smoke, and Trivy scan passed.

Hermes `smoke-hermes-1` failed only `chromium-version` and
`chromium-headless-render`: Debian's `/usr/bin/chromium` wrapper reads the
ARM64 host's `/proc/cpuinfo` and refuses missing SSE3. Direct execution of
`/usr/lib/chromium/chromium` under the same pinned, read-only mounted BuildKit
QEMU binary, `QEMU_CPU=max`, and the packet's network-none, nonroot,
read-only, cap-drop and no-new-privileges container restrictions passed both
the exact version and offline DOM render marker. This is an emulation-specific
probe finding; it does not establish that an agent's normal browser launch
works under binfmt. A corrected packet and full acceptance are pending.

The formal `scan-hermes-3` passed with zero HIGH/CRITICAL vulnerabilities and
zero secrets; package coverage was Ubuntu 331, Node 332, Python 110, Go 13.
The source and private vulnerability DB hashes were unchanged. The packet
reports the Debian-origin gate as not run because the script refuses an
ARM64 host with an AMD64 image; this remains a release gate. Earlier scan
attempts stopped at the 18 GiB floor plus 1 GiB sampling margin. One retired
Ubuntu integration dependency tree was archived and independently checked
(35,529 tar entries; SHA-256
`2e72a0ced579e4b37a05253208a0102ae8500b6663259ca745a3a4fd1b8bafd4`)
before removing only its original copy. A default-builder Buildx prune scoped
to cache entries last used more than 12 hours ago reclaimed 18.83 GB; all
Docker image IDs and the empty container list were unchanged. The pre-prune
cache and image inventories are in
`Claude outputs/runtime-recovery-20260928/default-buildx-aged-cache-prune-v1/`.
`acceptance-stage-1` passed its config-only fixture with the accepted ARM64
private engine and exact emulated AMD64 coordinator and Hermes images.
Acceptance launch, a 24-hour exact-image soak, registry manifest pin, and
release workflow gate remain open.

The Chromium-direct packet (`amd64-app-images-qemu-packet-v2-chromium-direct-smoke-v1`, `SHA256SUMS` `7325c3a139b7aaa6f828108a33edb8f523ab8fee72cad7acfa208e7a7ec7f7b6`) passed independent payload readback, 41 offline Python tests and 32 temporary-handler checks. `smoke-hermes-2` then passed on the adopted AMD64 image without `QEMU_CPU` or the Debian wrapper. This checks a direct headless probe, not the agent's normal desktop launch.

The first emulated `acceptance-launch` used the reviewed temporary, pinned F-only QEMU binfmt handler. Its self-tests passed; `real-hermes-smoke` passed. `real-sandbox-smoke` passed its first five isolation checks and failed selected-folder admission: under QEMU, Python `os.statvfs` reported a read-only bind as writable, while native stat and `/proc/self/mountinfo` reported it read-only. The handler trap restored the byte-identical prior binfmt inventory, removed the interpreter, and left no containers. Evidence is on the Ubuntu runner under `amd64-qemu-v2-ec2579be/acceptance-launch-1` and `amd64-binfmt-window-v1-tBasxGy5`.

`runtime/folder-mounts.ts` now takes each selected mount's mode from the kernel mount table while retaining the pinned device, inode, boot ID and inert-container admission. An independent review found that the first text parser could reject non-ASCII names and let crafted control characters spoof an access flag. The final parser reads bytes and splits only on the kernel's literal-space delimiter (`runtime/folder-mounts.ts` SHA-256 `1930dc5d2c252f89ee9cf3949cfa8ed83ab73c02201cd8e2adc1c6957dddb3b8`). The regenerated bundled runner SHA-256 is `a102701784c99ea883c21627218ae093472cc598883bbd14ccf1c0ab80d18542`. Four regression tests in `tests/folder-verifier.test.ts` execute the actual Python verifier against mount-table fixtures, including non-ASCII bytes, `\r`/`\v` injection, stacked mounts and ambiguous options; they pass on the final parser and two fail on the first version. Claude's independently hash-verified reproduction and test packet is `Claude outputs/runtime-recovery-20260928/folder-verifier-regression-test-v1/` (`SHA256SUMS` `5050f4c794bfbec2ebda31b320dc7b93f3dcf0583894485ecf660b8da2aca9e3`).

A restricted, network-free emulated AMD64 container executed the final verifier on actual RO and RW binds and reported `[true,false]`; separate Unicode and carriage-return source-folder binds also reported RO. The Ubuntu Node 22 source copy passed `npm test` (258 pass, 3 skip, 0 fail), typecheck, build, and lint (0 errors, 5 existing warnings). Its clean build snapshot contains the final verifier, bundle and test. A matching coordinator image, full acceptance rerun, final package, continuous 24-hour soak and release gates are still pending. These results are emulated AMD64 evidence on an ARM64 host, not native AMD64 evidence.

The independently hash-checked folder-mounts packet amendment has `SHA256SUMS` `0d492e259976a5b39a3b32589f7fe71bc07b6ad9102509d92f18d20e7bbfdebc`; 45 offline tests and 32 handler checks passed. It pins the verifier, generated runner and regression test, and verifies that the coordinator image contains the staged runner bytes. New emulated AMD64 session `amd64-qemu-v2-1ff505cb` staged source manifest `69ff7fe30e23bef15d7d560fdca99201ff5f1b5bc83097e2d79506d3a2476100`, adopted the unchanged Hermes image and built coordinator image `sha256:fb4270c31d7e5d4fd5bcc091607ac033a44ac5c37554f2628b9bb9ccf973dbaf`. Both images passed verify, restricted smoke and the frozen-database Trivy scan (zero HIGH/CRITICAL vulnerabilities and zero secrets; database `b15d9759…`). `acceptance-stage-1` passed with the accepted ARM64 private engine. The first attempted handler window stopped before registration because it was 165 MB below the packet's free-space reserve. The already adopted Hermes archive had a verified Mac copy with the same SHA-256, so only the redundant runner copy was removed; the capacity check then passed.

The second temporary F-only handler window ran the real acceptance fixtures. `real-hermes-smoke` passed; `real-sandbox-smoke` passed all eight checks, including distinct private files, common shared files, denied ungranted host paths, enforced selected-folder RO/RW modes and revocation after returning to Private workspace. `real-desktop-smoke` failed: `browser_navigate` timed out after 120 seconds opening Chromium. The packet stopped at this fixture and did not run later Compose or restore fixtures. Its result is a failure, not AMD64 desktop acceptance. The handler trap restored the exact prior binfmt inventory, removed the interpreter and left no containers. Evidence remains in `amd64-qemu-v2-1ff505cb/acceptance-launch-1` and `amd64-binfmt-window-v1-fMuBBhJB` on the Ubuntu runner.

A separate diagnostic window passed `AGENT_BROWSER_EXECUTABLE_PATH=/usr/lib/chromium/chromium` only to `docker exec` processes. The browser then failed faster with `CDP response channel closed`; six x86-64 Chromium guest cores carried SIGTRAP in zygote processes and SIGABRT in the main process. One main core contains Chromium's fatal `GPU process isn't usable` message. The six cores were SHA-256-listed and archived as `chromium-cores.tar.zst` (archive SHA-256 `3cb46fdb952aaaaa85b2d5636a765d1529979339054eb7a028c5fa6e9d0345c8`); a byte-identical private Mac copy is under `/Users/codeanddev/.local/state/open-harness-verification/amd64-desktop-diagnostic-v1/`. Only after compression, integrity testing and Mac readback were the six original runner cores removed. The diagnostic handler also rolled back exactly and left no containers.

A second diagnostic supplied that executable path plus agent-browser's documented `--disable-gpu,--no-zygote,--disable-dev-shm-usage` arguments and disabled core dumps in its temporary test containers. `browser_navigate` passed, but the later headed `agent-browser ... open` command failed with `CDP response channel closed`; this still does not establish private desktop input. Its temporary handler rolled back exactly, and no containers remain. The diagnostic environment overrides were not applied to production code or counted as acceptance. AMD64 headed Chromium under the current QEMU user-mode handler remains the immediate platform blocker; final package, Compose/restore, 24-hour soak, published digest and release workflow gates remain open.

Further isolated fixture copies on the Ubuntu runner narrowed the emulation failure. With the three no-GPU/no-zygote flags added to the headed browser's `--args`, Chromium opened but its controlled tab stayed at `about:blank` in the bounded v3-v5 checks. The v5 tab list contained one active blank page; X11 showed a visible `about:blank` Chromium window. In v6, a second `agent-browser open` after five seconds reached the fixture title; the HTTP server recorded both requests, and the saved desktop image visibly showed the button. CUA still returned no actionable button. V7 recorded only the Chromium frame in the CUA SOM elements, and a background pixel click was refused. V8 proved foreground pixel input changed the page to `CLICK_CONFIRMED_729`; its process listing showed the headed Chromium browser had the three emulation flags but lacked `--force-renderer-accessibility`, despite that flag in the fixture's CLI `--args`.

V9 supplied `--force-renderer-accessibility` in the temporary `AGENT_BROWSER_ARGS` override along with the three emulation flags. The headed page then loaded immediately and CUA found its accessible button; the fixture next failed only because its pixel click used background delivery. V10 changed that click to `delivery_mode='foreground'` in the **isolated test copy** and passed the complete private-desktop fixture: real browser navigation and snapshot, screen/window captures, pixel click and readback, accessibility click with a snapshot-bound element token, stale-token rejection, foreground typing and readback, doctor status, second-agent desktop and private-file isolation, shared-file access, restart, and desktop revocation. Evidence is under `amd64-desktop-diagnostic-v10-foreground-fixture/tmp/open-harness-desktop-smoke-xYamol/evidence.json` on the Ubuntu runner. Its temporary F-only handler window `amd64-binfmt-diagnostic-v10-JhIMlcZo` restored the byte-identical binfmt inventory and left zero containers; v3-v9 windows likewise rolled back exactly.

These are **emulated AMD64 diagnostics**, not the pinned acceptance packet. They injected a direct Chromium executable and changed browser process flags only for Docker exec, and v10 altered a fixture copy rather than production source. The flags change Chromium's process model, so the original desktop gate and later Compose/restore, 24-hour soak, published digest and release gates remain open. No production browser configuration or `tests/real-desktop-smoke.mjs` was changed by these diagnostics.

After the diagnostics, the checked-in `tests/real-desktop-smoke.mjs` changed one line to request foreground delivery for its pixel click. This uses the driver's documented route for a visible but unfocused Chromium renderer and still requires the actual page readback; the separate accessibility click, token forwarding and stale-token refusal remain. The resulting file SHA-256 is `208a9d95a8caa452b6a6a6beaa86e43e1f022e8868c04f75f87948791d9753d4`, verified after transfer to Ubuntu, where Node 22 syntax-check passed. V10 had already exercised that exact click change against the emulated runtime. A new pinned acceptance packet, clean-source stage and production desktop run are still required.

The v10 diagnostic's fixture result, browser/desktop screenshots, exact temporary fixture and Docker-exec override scripts, and handler preflight/rollback records were archived privately as `amd64-desktop-v10-evidence.tar` (16 members, SHA-256 `34d075482bb1e6c898a2d3fe85958577c406b6e38328245ca58af736c0ec5e4f`). The archive hash matched after transfer to `/Users/codeanddev/.local/state/open-harness-verification/amd64-desktop-v10-evidence.tar`; the original remains on the Ubuntu runner. It contains no model/provider credential.

The exact changed fixture in a new isolated Ubuntu Node 22 source copy passed `npm run lint` with zero errors and the same five existing warnings as the earlier full lint run. This lint copy is separate from the clean acceptance source snapshot.

The next reviewed packet (`amd64-app-images-qemu-packet-v2-compose-browser-overrides-v1`, `SHA256SUMS` `99a086041c97e8b3f4189bdb3bba829daf38a289f0fb64946691f50b047beed7`) verified all 75 payloads on Mac and Ubuntu. Its no-delete Ubuntu offline run passed 68 tests and 32 temporary-handler checks with no skips. The checked-in `tests/compose-smoke.mjs` first took its reviewed emulation-only nested desktop override (SHA-256 `0596438381cb704fc773d89f070ec3694a8164a1ecc3bfa24f96a35a8c1bfc96`). A separate Ubuntu source copy passed Node 22 syntax, typecheck, `npm test` (258 pass, 3 skip) and lint (zero errors, five existing warnings). The ordinary, marker-unset Compose path was unchanged.

Eight isolated real emulated AMD64 Compose diagnostics then ran with the reviewed temporary F-only QEMU handler, exact before/after binfmt inventory checks and zero remaining containers. V1-v3 timed out on the first real Hermes run before desktop input; the v3 dashboard proxy returned 502 `fetch failed` after a temporary 60-second API deadline. In held-open v4-v5, the coordinator and proxy became responsive and the same Hermes run reached `clarify.request` with 31 events after the fixture had already failed. The synchronous nested Docker CLI on the coordinator event loop under emulation can delay API responses; this is an emulation timing finding, not proof of a native timeout. Claude's separate reviewed timing packet (`compose-emulated-api-timing-retry-v1`, `SHA256SUMS` `a9796ff6330359b420831a9c25719c1eedc3b14b8b4b869dd2ffc3ea09bfb8f6`) passed 12 offline tests. Its checked-in marker-only fixture change raises the emulated GET deadline to 180 seconds and run wait to 600 seconds, and retries only response-free or proxy-502 GETs up to three times; writes and the marker-unset 15-second/120-second path remain unchanged. The resulting `tests/compose-smoke.mjs` SHA-256 is `5ab460e8e79f1b4525ec7135a940c1bd9f4388dc5f901aef0192fefa5ad06181`.

V6 passed the first real Hermes run, restart and durable state, then failed the first nested private desktop with `CDP response channel closed`. V7 preserved two x86-64 Chromium zygote cores from the inner agent. Their process environment contained only `AGENT_BROWSER_ARGS=--force-renderer-accessibility`: the helper's explicit `--args` had replaced the four emulation flags at the cold first open. Their integrity-tested compressed archive is private on Mac at `/Users/codeanddev/.local/state/open-harness-verification/amd64-compose-final/nested-cores-v7.tar.zst` (SHA-256 `ac523336cdfd6ebcc1a95bd163a4b8e4612788f8e8ed25ba29e754ce6025f919`). After matching both original core hashes and verifying that archive, the runner originals were removed to meet the acceptance disk reserve. Cores may contain runtime memory and are not publication artifacts.

V8 used an isolated source copy with the same emulation marker, a simpler temporary 60-second/300-second GET retry, and a helper-only cold-open change: if and only if the direct Chromium path and exact four reviewed flags are present, omit the helper's explicit `--args`; otherwise retain its previous call. The **entire real Compose and empty-volume backup/restore diagnostic passed**. Evidence reports two nested desktop helper execs, click readback `CLICK_CONFIRMED_729`, type readback `COMPOSE_DESKTOP_729`, two-agent private desktop isolation, preserved shared files, cleaned resources, 160 restored entries with file/owner/mode hashes, usable credentials, no replay of interrupted runs and private desktop input after restore. Its evidence is on Ubuntu under `amd64-compose-diagnostic-v8`; the diagnostic plus handler rollback records are preserved privately on Mac as `/Users/codeanddev/.local/state/open-harness-verification/amd64-compose-final/diagnostic-v8.tar.zst` (tested archive SHA-256 `c03e50ae098f50bdc970b2216d430f9d409baf59c0af162dd2ca9056fc2b6108`). The exact proven helper change is now checked in as `tests/helpers/compose-desktop.py` SHA-256 `e527929afe5f040258dbc0875edfd2188223eb01e6dee75ce73ac454759460d4`. A fresh Ubuntu source copy with this helper and the reviewed timing fixture passed Python syntax, Node syntax, lint (zero errors, five existing warnings), typecheck and `npm test` (258 pass, 3 skip). V8 is an **isolated emulated diagnostic** against temporary fixture copies, not a run of the final pinned packet or a model-reasoning test. The formal exact-source acceptance, 24-hour exact-image soak, published registry manifest and release workflow gate remain open.

Claude's corrected `amd64-app-images-qemu-packet-v2-compose-emulated-fixtures-v2` has `SHA256SUMS` `0d320a0761dba8e4254554e62a640a9c1492a6766ac06c915ef65cadd4d60994`: all 109 payloads matched on Mac and Ubuntu. It pins both current Compose files and the foreground desktop fixture, and all 27 source pins matched the clean Ubuntu snapshot. Its independent Ubuntu no-delete run passed 98 tests, 32 handler checks, zero skips and zero `__pycache__` directories, with the integrity-verified agent-browser 0.37.1 ARM64 probe enabled. Formal emulated AMD64 session `amd64-qemu-v2-38fb5a0c` staged source manifest `720141f4bd559f9dc4646d1b5b2d2d043710436c6e3a6346a7c546e34d899e2c`, adopted Hermes `sha256:88cfa852e05a7aa7feb6455b645a6fff4118bb99f57a1499b36897e5bfd06bfb` and built coordinator `sha256:f7fd4e6f1c9b269677fba341c6ef95ae1fcd030c231193c258320cc1005e6939`. Both images passed verify, restricted smoke and the frozen Trivy scan with zero high/critical vulnerabilities and zero secrets (DB `b15d975972da97057af64f60a1027191064932d6c90fd7e22631b7295bc038fe`); config-only acceptance-stage passed.

Formal labelled acceptance attempt 1 passed the real Hermes fixture and all eight sandbox checks, then failed `real-desktop-smoke` at `check.py`'s cold headed open with `CDP response channel closed`. Its explicit `--args --force-renderer-accessibility` replaced the four emulation flags, the same precedence found in the Compose helper. The packet stopped before Compose/restore, so this is a failed full acceptance attempt. The F-only handler window `amd64-binfmt-formal-v2-6LW308aN` restored the exact prior binfmt inventory and left zero containers. The attempt receipt, generated failing helper, logs and rollback record are archived privately on Mac with the next diagnostic as `/Users/codeanddev/.local/state/open-harness-verification/amd64-formal-v2/attempt1-and-desktop-diag.tar.zst` (integrity-tested SHA-256 `6e8d2bd86a98bd1d000525cd6498894b2a74d4d5d3331ff8f079baacda35dd32`). Two new Chromium cores from that failure were preserved in a separate tested private Mac archive `attempt1-chromium-cores.tar.zst` (SHA-256 `50685520b211f010f24e9ff43f8e0acccf2dfe01cda8e67b854ab47ccddb864f`); their hashed runner originals were removed after archive verification. Neither archive is a publication artifact.

An isolated source copy then changed only the embedded desktop helper's cold-open call: under the exact reviewed direct executable and four browser flags it omits the CLI `--args` pair; under every other environment it keeps the previous call. The full real desktop fixture **passed** against the same Hermes image: browser navigation/snapshot, foreground pixel and accessibility clicks with page readbacks, snapshot-bound token forwarding and stale-token refusal, foreground typing, two-agent private file/window isolation, shared-file access, container restart and desktop revocation. Its file SHA-256 is `8e494aae341e2e961161eb0b4835d2435005f03211d100d9a67bfab042deec2b`, now byte-identical to checked-in `tests/real-desktop-smoke.mjs`. The diagnostic and handler records are in the private archive above; `amd64-binfmt-desktop-cold-open-v1-2vgB5HBI` rolled back binfmt byte-for-byte and left zero containers. This is a **passed isolated desktop diagnostic**, not yet a full pinned packet acceptance. A new exact-source packet, complete Compose/restore acceptance, 24-hour soak, published digest and release gates remain open.

The final exact-source packet `amd64-app-images-qemu-packet-v2-desktop-cold-open-v1` has `SHA256SUMS` `129b905c059e0e839f37b2165ce56283550b0c8ece399283a827086c8d655c42`; all 121 payload hashes matched on Mac and Ubuntu, all 27 source pins matched, and the independent Ubuntu no-delete suite passed 116 Python tests plus 32 temporary-handler checks with no skips. Session `amd64-qemu-v2-d9e73374` staged source manifest `301df52c21b843949c7de2fba8b78efcf1ef971827cf7d57cb98d5522e4abb7c`, adopted Hermes image `sha256:88cfa852e05a7aa7feb6455b645a6fff4118bb99f57a1499b36897e5bfd06bfb` and built coordinator image `sha256:ca82276ec2e5270c0b68e096430c15ba8b1e36ae4c78846f1947c722d82b8ff7`. Both passed image verification, restricted smoke and frozen Trivy scans with zero high/critical vulnerabilities and zero secrets; `acceptance-stage-1` passed.

The **full formal emulated AMD64 acceptance passed** at 2026-09-30 10:02 UTC as `acceptance-with-browser-overrides-1` (receipt `ok: true`). Real Hermes, all eight sandbox checks, private desktop and the complete real Compose/empty-volume backup-and-restore fixture returned zero. The desktop fixture confirmed click `CLICK_CONFIRMED_729`, typing `DESKTOP_TYPED_729`, two-agent private file/window isolation, shared files, restart and revocation. Compose confirmed two nested private desktop helper runs, click `CLICK_CONFIRMED_729`, typing `COMPOSE_DESKTOP_729`, two-agent isolation, shared files and cleanup. Restore into a separate empty project compared 160 file/owner/mode-hashed entries and recovered profiles, usable credentials, private and shared files, memory, skills, tasks, history and private desktop input; interrupted runs did not replay. The marker-only Compose emulation timing allowed 180-second GETs, a 600-second run wait and up to three response-free/proxy-502 GET retries; the evidence recorded four such retries and two GETs above the native 15-second budget. No writes were retried. This is emulated `linux/amd64` coordinator/Hermes on an ARM64 host with an accepted ARM64 private engine, scripted provider responses and the reviewed browser overrides. It is not native/default-browser evidence or paid-model reasoning.

The temporary F-only QEMU window `amd64-binfmt-formal-desktop-cold-open-lsfyrcfu` exited 0, removed its handler/interpreter, restored the byte-identical prior binfmt inventory and left no Docker containers. Acceptance receipt, phase checks, fixture evidence and rollback records are preserved privately on Mac at `/Users/codeanddev/.local/state/open-harness-verification/amd64-formal-final/acceptance-v1.tar.zst` (SHA-256 `58acfd889ca22b7c0efbe4e6ebb5540b6568de07241a9dfffffd9d5702ed3011`, matching the Ubuntu archive; remote zstd integrity test passed). A 24-hour exact-image soak, clean-host real-provider/source-package acceptance, a published GHCR private-engine AMD64 manifest digest and the protected release-workflow gate remain open. The protected workflow patch was rejected by automatic approval review; no release was published.


## September 30, 2026 — emulated soak preflight correction and launch

The completed Claude Desktop Opus 5.5 soak extension was independently checked on the Ubuntu ARM64 runner (Node 22.23.3). Its v1 packet (`SHA256SUMS` `94a131f7d0132b779b76d366791e7056376d68b4e1cee68e7ca00e51ff669d56`) matched all 146 payload hashes, but the real read-only smoke preflight refused: it bound the packet template pins `6993a5fb…`, whereas the accepted `amd64-qemu-v2-d9e73374` session has filled Hermes-adoption pins `0ee5c565b386a1de9cb5809984bc511c3b421705ec6b09738e846eb62bad3ca2`. All 27 acceptance source pins and five soak source pins still matched the repository. The independent v1 offline run finished 171 passing tests and one exact-directory failure caused by Mac AppleDouble transfer metadata; after quarantining those extra files, that test passed. All 32 handler-procedure checks passed, with no skipped tests or Python caches. This was an offline verification, not a completed soak.

Opus supplied a separate `amd64-app-images-qemu-packet-v2-emulated-soak-v2` packet (`SHA256SUMS` `c1ea25f2b88aa0d5f020a4326da9ead4781e0cfe312ff9ea1465bb5a8780f47b`, 151 payloads). Root independently verified every payload on Ubuntu, reviewed the diff, and passed its 12 targeted adopted-session and pin regressions. Only the session binding and its controller hash changed; images, source pins, policies, deadlines, cleanup and handler logic stayed unchanged. Unused build-cache reclamation reported 7.455 GB and preserved every image ID/tag, bringing free space above the full soak's 39 GiB start requirement. The corrected real smoke preflight passed.

At 2026-09-30 22:45:55 UTC, root launched the detached temporary-handler window `amd64-soak-smoke-window-20260930-v2` (PID 3804771) for `soak-smoke-with-browser-overrides-1`. Its handler and child-process checks passed, and the three Compose services became healthy. **The real smoke is running; neither it nor the 24-hour soak is recorded as passed.** The fixture runs Compose/restore before the five-minute loop. Receipts and journals remain under the same accepted session on Ubuntu. The current-chat follow-up `finish-open-harness-soak` checks every 30 minutes and may launch the full soak only after the smoke, exact rollback, zero-container cleanup and a fresh full-soak preflight pass. Clean-host real-provider/package acceptance, published engine-input manifest digests for both AMD64 and ARM64, and the previously rejected protected workflow patch remain separate open gates.


### 2026-09-30 23:21 UTC — smoke status unavailable; final offline audit collected

Collected Opus 5.5's final audit from the existing Claude Desktop conversation and verified all seven payload hashes in `Claude outputs/runtime-recovery-20260928/amd64-app-images-qemu-packet-v2-emulated-soak-v2-offline/SHA256SUMS` (manifest SHA-256 `972d9423fdf570957b4820f842ae343ca113adb08c7470e5f20d65d3e3e4f5ce`). Its actual logs record 178 passing offline tests, no skips, all 32 handler-procedure checks passing, and no remaining packet bytecode cache. These are Claude sandbox results, separate from root's independent v1 suite and 12 v2 regression/pin checks. The audit found no further launch blocker, conditional on a passing real smoke, verified cleanup, and a fresh 39 GiB full-soak preflight. Archived and read back the audit privately at `/Users/codeanddev/.local/state/open-harness-verification/emulated-soak-20260930/opus-v2-offline-audit.tar.gz`, SHA-256 `71db7e90893e7dcfb8847ae0f47458ef6afad18e8e29c8b9cdcfb88365b3d4b1`.

The heartbeat could not read the real smoke's receipt: the authorized `ssh-ubuntu` route timed out connecting to `192.168.1.149:22`; a second attempt was bounded at 25 seconds and also timed out without output. Therefore `amd64-soak-smoke-window-20260930-v2` has **unknown current status**, including its container cleanup and handler rollback. This is a connectivity blocker, not evidence of a test failure or pass. No recovery mutation or full soak was launched. The follow-up remains active to verify receipts and cleanup once connectivity returns; any failed smoke must block full-soak launch. Results remain scoped to emulated AMD64 with browser overrides and a scripted provider. Clean-host real-provider acceptance, both published engine-input manifest digests, and the rejected protected release-workflow gate remain open.


### September 30, 2026 — emulated smoke passed; full soak launched

Reconnected through the authorized SSH helper. The smoke window finished at `2026-09-30T23:01:37Z` with both the window and attempt receipts passing. Root independently reran the packet's evidence verifier against the saved journal and all four fixture evidence files, using the recorded attempt time bounds: the recomputed summary exactly matches the receipt. Six alternating-agent cycles completed in 347,091 ms, with one planned clean SIGTERM/exit-0 restart; cycle times were 52.0–59.4 seconds. This is a five-minute smoke only (`durationQualified: false`), not the 24-hour gate. The receipt SHA-256 is `220dd1e70986ac4777e90eaec535cfde17967afcb2afe374d013f0f697ba0052`. Minimum controller-observed free space was 29,409,370,112 bytes.

Root verified the before/after handler files byte-for-byte, compared the current kernel inventory with the original, confirmed the handler/interpreter directory absent, and checked that Docker had zero containers. All 151 packet payloads still match manifest `c1ea25f2…`. The accepted source manifest remains `301df52c…`, with coordinator `ca82276e…`, Hermes `88cfa852…`, and engine `63004ab1…`. Privately archived the complete window, attempt and `sm1` evidence (46 files), and read back the archive: `/Users/codeanddev/.local/state/open-harness-verification/emulated-soak-20260930/smoke-v2-evidence.tar.gz`, SHA-256 `be38e586b87d194747c282f96a581576d1f4a27c4d04eb803795128637ffeca7`.

The fresh full-soak preflight passed with 44,634,062,848 bytes free versus its 41,875,931,136-byte (39 GiB) start requirement. Ubuntu's sleep/suspend/hibernate targets were inactive and logind IdleAction was `ignore`; this Mac's AC sleep setting is zero. The operator was reminded to keep the Ubuntu runner and VM host awake and avoid other Docker workloads. Following the reviewed `SOAK-WINDOW.md`, launched detached window `amd64-soak-24h-window-20260930-v2` at `2026-09-30T23:40:29Z`; window PID `3853572`. Preflight, F-only handler registration and both postflight checks passed; controller `3853845` launched at `23:40:32Z` and fixture `3853927` is executing `--soak` as attempt `soak-with-browser-overrides-1`. All three Compose services were healthy at the first check. The full soak is **running, not passed**; its 24-hour clock starts after the Compose/restore preparation. The unchanged policy requires at least 288 cycles, no gap over ten minutes, and one planned restart after the midpoint. The heartbeat now follows this exact window every 30 minutes and will verify the final evidence and cleanup before recording success.

This remains **emulated AMD64 with browser overrides and a scripted provider**. Clean-host real-provider acceptance, published engine-input manifest digests for both architectures, and the rejected protected release-workflow gate remain open. No publication or protected workflow mutation was performed.


## October 3, 2026 — local launch-request audit (2026-10-03 13:40 MDT)

The current checkout includes Claude's manual-approval delivery `81a41a8`.
Codex regenerated `runtime/runner.mjs` with no further bundle diff and added an
assertion on the generated profile's actual `config.yaml`: manual approvals,
unattended denial and scheduled denial. The restored source guard remains.

Removed test review: the pinned Ubuntu/Debian input and package-installation policy
is covered by `tests/ubuntu-runtime`, so the removed single-stage Debian-base,
old pip version and package-manager-removal assertions must not be restored.
The coordinator intentionally includes reviewed npm and Buildx for setup; the
old test forbidding CLI plugins/package managers was also obsolete. A replacement
checks the Docker client, nonroot runtime, absence of a bundled daemon and the
application health probe. The expired Trivy-exception count test stays removed;
whole-image scans remain HIGH/CRITICAL plus secrets with failure exit codes and
no exception file.

**Final-image scans remain unverified here.** The configured Docker Desktop socket
`/home/jarom/.docker/desktop/docker.sock` is absent outside the sandbox, and Trivy
is not installed. This check neither starts Docker nor builds/scans an image.
Historical zero-finding receipts apply only to their recorded images/databases;
no current zero-HIGH/CRITICAL claim or scan exception was added.

**September 30 full soak: result unavailable, not passed.** No receipt, journal,
fixture evidence or cleanup record for `amd64-soak-24h-window-20260930-v2` was
found in this checkout, including ignored files. This host has no SSH config;
Claude's handoff reports no key for the historical runner `192.168.1.149`.
The last committed record describes a launched run, not its final result. The
remote artifacts are not declared lost. Retrieve and verify them before any
recovery/relaunch; if unavailable or not bound to the final candidate, a new
qualifying final-image soak is required. No second run was launched and remote
container/handler cleanup remains unverified.

**Workflow gate is proposed, not applied.**
`work/release-review-20261003/debian-origin-workflow.patch` adds scanner/Python
checks, a dedicated database download, the exact scanned-image Debian-origin
check and receipt validation before runtime exercise/publication, and retained
reports/steps/JSON evidence. All three whole-image scans remain unchanged; no
new/re-versioned Actions, ignore files or weaker thresholds. The image-job budget
increases from 110 to 190 minutes to accommodate the existing 75-minute gate
with an 80-minute step limit. The actual workflow still fails its regression
guard until the reviewed patch is approved and applied.

Local verification for this delivery: Node suite 271 tests, 267 pass, one expected
workflow-guard failure and three skips; Python package suite 158 tests, OK with
31 evidence-dependent skips. TypeScript passes; lint passes with eight existing
warnings; regenerated runner has no diff from Claude's delivery. The isolated
candidate workflow passes all eight Debian-origin Node tests, YAML parsing,
new-step shell syntax and `git apply --check`. No workflow change was applied.
The initial production build failed after dependencies disappeared during another
session's `npm ci`; the subsequent shared build result is recorded separately.
Claude owns browser acceptance for its current onboarding/concurrency changes.


## October 3, 2026 — gate applied and native runtime rebuild

The user directed continuation after the concrete workflow-patch review/application
question. The reviewed Debian-origin gate was applied without changing scan
thresholds, Actions or permissions. The actual Node suite now passes: 268 passed,
zero failed and three skipped; typecheck passes and lint has zero errors/eight
existing warnings. Production dependency audit reports zero vulnerabilities.
Claude's production build completed standalone output and React dependency copying.
Claude records 124 browser passes and eight baseline-reproduced credential/UI
regressions (four cases across desktop/mobile), which remain with the UI owner.
Codex's separate-port browser attempt overlapped that fresh build and refused
missing dist output; it is not acceptance evidence.

Docker Desktop became available (29.5.3, native AMD64). The installed Hermes image
`sha256:8e2da94ccd50708d383d791accc59c3ff49857cd8a15ac4a8c8b44619ba1fda8`
is contract 2, not the required contract 7. A separate current-source review build
failed safely: the live Debian signed index no longer included locked Chromium
`154.0.8037.57-1~deb13u1`. An isolated signed snapshot probe at the reviewed cutoff
`20260929T180000Z` confirmed the exact package SHA256
`d70bab9fbcb7bfbb7227b9510fb5cf1f7290bd6d6af3dd168b19ba4cc9b8035d`.

The Debian input stage now obtains signed binary/source indexes at that same
reviewed cutoff via `debian_inputs.py configure-snapshot`. Only historical
snapshot Release expiry is disabled, as documented by Debian; keyring signature,
version, package/source identity, size and hash checks are retained. Ubuntu and
Debian package pins/lock bytes are unchanged. Date and suite injection regressions
and stage-order checks pass; the full Python package suite runs 160 tests, OK with
31 retained-evidence-dependent skips. A new native AMD64 image build is in progress;
this entry does not record image verification, scans, runtime acceptance or a
replacement soak as passed.

The scanner was extracted from immutable local image
`sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`:
Trivy 0.74.0, binary SHA256
`d89bcc6510a267f11b773398cbf1be5520ce39f9e8b6633178c4487f05b7d791`.
Its dedicated vulnerability database was downloaded into the ignored review cache.
No scan ignores were restored. The prior full soak remains unverified.

The second native build passed signed Debian snapshot retrieval and locked Ubuntu
installation, then failed at the offline curl-builder guard: this Docker Desktop
kernel exposes a regular `/sys/class/net/bonding_masters` metadata file beside
interface directories. The guard tried to read its nonexistent `flags` child.
The helper now skips regular metadata files, while still rejecting an active
non-loopback interface or unreadable interface flags. Two regressions cover those
cases; the curl suite runs 24 tests, OK with eight retained-evidence skips. A third
native build is running; no image scan or acceptance is recorded as passed.
