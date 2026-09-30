# Open Harness engine: the official Docker 29.8.1 DinD image, with reviewed replacements for
# containerd, runc and Buildx and the Alpine libexpat security update. See README.md.
#
# The release workflow builds this for each target architecture with `network: none`. Only two
# images are pulled: the official base below, and ENGINE_INPUTS, which is the reviewed inputs
# image for this architecture pinned by digest in inputs.lock.json. The build context is staged
# from that lock by `node scripts/release-images.mjs stage-engine-context`: it holds
# inputs.sha256 and NOTICE.md.
ARG ENGINE_BASE=docker.io/library/docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0
ARG ENGINE_INPUTS

FROM ${ENGINE_INPUTS} AS inputs

FROM ${ENGINE_BASE} AS verified
COPY --from=inputs / /inputs/
COPY inputs.sha256 /inputs.sha256
# The inputs must match the lock exactly: regular files and directories only, no extra or missing
# files, reviewed modes, and matching hashes.
RUN set -eu; cd /inputs; \
    if find . ! -type f ! -type d | grep -q .; then echo 'Engine inputs contain a link or special file.' >&2; exit 1; fi; \
    if find . -type d ! -perm 755 | grep -q .; then echo 'Engine input directories must be 0755.' >&2; exit 1; fi; \
    if find . -type f \( -path './containerd/bin/*' -o -path './runc/bin/*' -o -path './buildx/bin/*' \) ! -perm 755 | grep -q .; then echo 'Engine binaries must be 0755.' >&2; exit 1; fi; \
    if find . -type f ! -path './containerd/bin/*' ! -path './runc/bin/*' ! -path './buildx/bin/*' ! -perm 644 | grep -q .; then echo 'Engine data files must be 0644.' >&2; exit 1; fi; \
    find . -type f | sed 's|^\./||' | LC_ALL=C sort > /tmp/found; \
    sed 's/^[0-9a-f]\{64\}  //' /inputs.sha256 | LC_ALL=C sort > /tmp/expected; \
    if ! cmp /tmp/found /tmp/expected >&2; then echo 'Engine input files differ from inputs.sha256.' >&2; exit 1; fi; \
    sha256sum -c /inputs.sha256 > /dev/null

FROM ${ENGINE_BASE}
ARG ENGINE_BASE
ARG ENGINE_INPUTS
ARG ENGINE_INPUTS_LOCK_SHA256
ARG CONTAINERD_VERSION
ARG CONTAINERD_SOURCE_MANIFEST
ARG RUNC_VERSION
ARG RUNC_SOURCE_MANIFEST
ARG BUILDX_VERSION
ARG BUILDX_SOURCE_MANIFEST
RUN --mount=type=bind,from=verified,source=/inputs/apk,target=/tmp/open-harness-apk set -eu; \
    apk add --no-network --no-cache /tmp/open-harness-apk/libexpat-2.8.5-r0.apk; \
    apk info -e 'libexpat=2.8.5-r0' > /dev/null
COPY --from=verified --chown=0:0 --chmod=0755 /inputs/containerd/bin/ /usr/local/bin/
COPY --from=verified --chown=0:0 /inputs/containerd/provenance/ /usr/local/share/open-harness/containerd-remediation/
COPY --from=verified --chown=0:0 --chmod=0755 /inputs/runc/bin/runc /usr/local/bin/runc
COPY --from=verified --chown=0:0 /inputs/runc/provenance/ /usr/local/share/open-harness/runc-remediation/
COPY --from=verified --chown=0:0 --chmod=0755 /inputs/buildx/bin/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=verified --chown=0:0 /inputs/buildx/provenance/ /usr/local/share/open-harness/buildx-remediation/
# COPY's file mode also applies to newly created destination directories.
RUN mkdir -p /usr/local/share/open-harness/engine && chmod 0755 /usr/local/share/open-harness/engine
COPY --chown=0:0 --chmod=0644 NOTICE.md /usr/local/share/open-harness/engine/NOTICE.md
LABEL org.opencontainers.image.title="Open Harness engine" \
      org.opencontainers.image.base.name="${ENGINE_BASE}" \
      dev.openharness.engine.notice="Unofficial derived engine; sources, licenses and build provenance are in /usr/local/share/open-harness/" \
      dev.openharness.engine.expat="2.8.5-r0" \
      dev.openharness.containerd.version="${CONTAINERD_VERSION}" \
      dev.openharness.containerd.source-manifest="${CONTAINERD_SOURCE_MANIFEST}" \
      dev.openharness.runc.version="${RUNC_VERSION}" \
      dev.openharness.runc.source-manifest="${RUNC_SOURCE_MANIFEST}" \
      dev.openharness.buildx.version="${BUILDX_VERSION}" \
      dev.openharness.buildx.source-manifest="${BUILDX_SOURCE_MANIFEST}" \
      dev.openharness.engine.inputs="${ENGINE_INPUTS}" \
      dev.openharness.engine.inputs-lock-sha256="${ENGINE_INPUTS_LOCK_SHA256}"
