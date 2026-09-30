# Open Harness engine notice

This image is an unofficial derivative of the official Docker Engine image
`docker.io/library/docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`.
It is not produced or endorsed by Docker, Inc. or by the containerd, runc or Buildx projects.

Everything not listed below is unchanged from the official image and remains covered by that
image's own notices.

- **libexpat.** The Alpine package is updated to `2.8.5-r0`, installed from Alpine's signed package.
- **containerd.** `containerd`, `containerd-shim-runc-v2` and `ctr` in `/usr/local/bin` are replaced
  by containerd 2.3.6, rebuilt with dependency updates.
  - Complete source, vendored dependencies with their licenses, and build provenance:
    `/usr/local/share/open-harness/containerd-remediation/`.
- **runc.** `/usr/local/bin/runc` is replaced by runc `1.5.2+open-harness.xnet0.56.0`: upstream
  1.5.2 (commit 29dd3dc2b13b4123162e5fe132504bb4b15569f1) with `golang.org/x/net` v0.56.0.
  - It is statically linked with Debian's glibc, libseccomp and GCC runtime libraries.
  - Complete runc source, vendored dependencies, the corresponding Debian sources and copyright
    files for the static libraries, and build provenance: `/usr/local/share/open-harness/runc-remediation/`.
- **Buildx.** The CLI plugin `/usr/local/libexec/docker/cli-plugins/docker-buildx` is replaced by
  Buildx 0.37.1, from upstream commit
  0b265a9f62db554fa9aba6dd19e1bd5704bc7d8a.
  - Complete source, vendored dependencies with their licenses, and build provenance:
    `/usr/local/share/open-harness/buildx-remediation/`.

containerd, runc and Buildx are licensed under the Apache License 2.0.

- **License texts.** They are in the included source archives. Buildx's is also provided as `LICENSE` in its directory.
- **Go toolchain.** All three were built with Go 1.26.8. Go's license and patent grant are included as
  `Go-LICENSE` and `Go-PATENTS` in the runc and Buildx directories.
- **Libraries linked into runc.** Their licenses are in the Debian copyright files and source packages shipped with it.

The image labels `dev.openharness.engine.inputs` and `dev.openharness.engine.inputs-lock-sha256`
identify the exact reviewed inputs recorded in Open Harness `runtime/engine/inputs.lock.json`.
The build context appends the architecture's stamped component versions and source manifest
hashes from that lock below. Each hash identifies a manifest file shipped with the component.
