# Derived engine packaging

The release pipeline packages `ghcr.io/<owner>/open-harness-engine`. This unreleased integration remains blocked by the incomplete inputs lock and the application/platform acceptance gates.

- **What it is.** The official `docker:29.8.1-dind` index, pinned by digest, plus the reviewed containerd, runc and Buildx rebuilds and Alpine `libexpat` 2.8.5-r0.
- **How it is released.** Exactly like the coordinator and Hermes: built for each target architecture, scanned, exercised, published per architecture, joined into one index, recorded in `image-lock.json` and promoted as `v<version>`.
- **Source builds.** `compose.yaml` still defaults to the official engine, and `Dockerfile.coordinator` still defaults to the official Buildx plugin.

| File | Purpose |
| --- | --- |
| `inputs.lock.json` | Schema 2: base index and Expat version, then per architecture the component versions, source manifests, every input file's SHA256 and the inputs image digest. |
| `Dockerfile` | Release assembly. It pulls only the base and the inputs image, verifies the inputs against `inputs.sha256`, and needs no network for `RUN`. |
| `Dockerfile.inputs` | Packages one architecture's reviewed input directory as a data-only image. |
| `NOTICE.md` | Attribution template; staging appends the architecture's exact versions and manifests. Shipped at `/usr/local/share/open-harness/engine/NOTICE.md`. |

## Input layout, per architecture

```text
apk/libexpat-2.8.5-r0.apk                                  0644
containerd/bin/{containerd,containerd-shim-runc-v2,ctr}   0755
containerd/provenance/...                                  0644
runc/bin/runc                                              0755
runc/provenance/...                                        0644  (includes static-library sources)
buildx/bin/docker-buildx                                   0755
buildx/provenance/...                                      0644
```

Directories are 0755. There are no symlinks, no hidden files and no other files.

The binaries and provenance directories are installed at the paths used by the reviewed ARM64 candidate `sha256:87f075ed…`:

- `/usr/local/bin/{containerd,containerd-shim-runc-v2,ctr,runc}`;
- `/usr/local/libexec/docker/cli-plugins/docker-buildx`;
- `/usr/local/share/open-harness/{containerd,runc,buildx}-remediation/`.

Release coordinators mount the same inputs image and take `buildx/bin/docker-buildx` and `buildx/provenance/` from it. They check the installed binary against `BUILDX_SHA256` from the reviewed lock before executing it. The Dockerfile records the actual input and hash arguments as labels for the release validator.

## Release gate

Each architecture's lock entry is either `complete` or `incomplete`.

- **Incomplete** entries name every missing input. `verify-engine-inputs` fails the release before any image job runs.
- **Complete** entries need all of the following:
  - an `inputs` image pinned by digest;
  - a SHA256 for every file;
  - the Expat package and all five binaries;
  - a stamped version and source manifest for each component, with the manifest's SHA256 equal to its entry in `files`.

Source manifests bind architecture-specific build inputs, and stamped Buildx versions include
a manifest prefix. They must be reviewed independently for each architecture. Schema 1's
shared component metadata is rejected. Unknown metadata in an incomplete architecture is
explicitly `null`; ARM64 records must not stand in for an unbuilt AMD64 component. The retained
ARM64 files remain bound to their original recipes until those components are rebuilt.

`stage-engine-context` derives the image labels' build arguments and the appended notice from
the selected architecture. Candidate validation checks those labels against the same lock;
the Dockerfile verifies the shipped source manifests through the exact-file checksum list.

Before publication, the engine must pass the same gates as the other images:

- the Dockerfile's exact-file check;
- label binding to the lock (`validateEngineCandidate`), and the coordinator's Buildx input and checksum labels (`validateCoordinatorBuildx`);
- the strict Trivy scan;
- the real smoke tests and Compose acceptance.

Nothing is whitelisted.

## Producing an inputs image

1. Assemble the directory from the reviewed build outputs. Put nothing else in it: no Dockerfile and no `.dockerignore`.
2. Run `node scripts/release-images.mjs check-engine-inputs <dir> <arch>` until it reports no difference. For a still-unpinned file, it prints the observed hash for review; it never accepts it.
3. Build with `Dockerfile.inputs` for the explicit target platform, then review and push. Record the manifest digest in the lock.

Only then can the entry become `complete`.

## Build and execution environments

Physical hardware for each target is not an MVP requirement. Docker/BuildKit
emulation and cross-compilation are acceptable build strategies; see
[Docker's multi-platform build documentation](https://docs.docker.com/build/building/multi-platform/).
Record host/daemon architecture, target platform and execution mode with the build
inputs. Execute and test each resulting architecture, retaining image, toolchain
and source identities. Cross-compilation alone does not establish runtime behaviour,
and emulated evidence must not be described as native. The earlier native-only
component controllers require an explicit emulation mode before using that path;
do not spoof their host checks. ARM64 provenance cannot stand in for AMD64 outputs.
