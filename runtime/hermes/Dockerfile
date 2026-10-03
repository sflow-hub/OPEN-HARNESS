# Open Harness Hermes runtime on Ubuntu 26.04. Native builds are the default.
# An AMD64 build on an ARM64 builder requires --build-arg OPEN_HARNESS_BUILD_MODE=emulated.
# Needs BuildKit's built-in Dockerfile frontend (RUN --mount=type=bind and RUN --network=none).
# Build the default (last) target: it depends on the verify stage; `--target runtime` would skip verification.
# All stages verify the target architecture; unsupported targets have no base stage.
# Every pinned value here must match runtime/ubuntu/lock/runtime-inputs.lock.json (checked by the offline tests).
# Ubuntu APT steps use the locked, signed Ubuntu snapshot (runtime/ubuntu/helpers/ubuntu-snapshot.sh).

ARG TARGETARCH
ARG OPEN_HARNESS_BUILD_MODE=native

# Per-architecture manifests of the verified multi-architecture indexes.
FROM docker.io/library/ubuntu@sha256:e03767b4dc7cb87fc57b1f119d40d9a997ecc5570dc6e22d57d6b7e333bbe78c AS oh-ubuntu-arm64
FROM docker.io/library/ubuntu@sha256:61ebaa5cc23ca45450db85eac015435199ec569e28ec222ea13f2aed2110b8a6 AS oh-ubuntu-amd64
FROM docker.io/library/python:3.12.14-slim-trixie@sha256:950206c37262dd86c55659797f6ee418fee30535072f65a82ed470d985f5cda5 AS oh-python-arm64
FROM docker.io/library/python:3.12.14-slim-trixie@sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b AS oh-python-amd64
FROM docker.io/library/node:24.21.0-trixie-slim@sha256:7da5980a342ed134ad56bb16c918f94548cd15cf3b961aa231c286598accb536 AS oh-node-arm64
FROM docker.io/library/node:24.21.0-trixie-slim@sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697 AS oh-node-amd64
FROM oh-ubuntu-${TARGETARCH} AS oh-ubuntu
FROM oh-python-${TARGETARCH} AS oh-python
FROM oh-node-${TARGETARCH} AS oh-node

# The reviewed helper sources and the hash-checked lock files. Later steps bind-mount them read-only;
# none of them is left in the runtime image.
FROM oh-python AS build-inputs
ARG TARGETARCH
ARG BUILDARCH
ARG OPEN_HARNESS_BUILD_MODE
COPY runtime/ubuntu/helpers/ /opt/open-harness-build/helpers/
COPY runtime/ubuntu/lock/ /opt/open-harness-build/lock/
RUN chmod -R a+rX /opt/open-harness-build \
 && cd /opt/open-harness-build/lock \
 && printf '%s  %s\n' \
      fca5697674b3d2a7a9945982f2bb7d18e5374160eb479fb969bcb83f0892d491 runtime-inputs.lock.json \
      412125b2cc346b4db3eadcb662d740060b1ed9ef3f8d14db86da048ac5c73d5b ubuntu-os-packages.txt \
    | sha256sum --check --strict - \
 && sh /opt/open-harness-build/helpers/check-native-platform.sh \
 && python3 /opt/open-harness-build/helpers/debian_inputs.py plan --lock runtime-inputs.lock.json --arch "$TARGETARCH"

# Network stage in the official pinned Debian image: signed APT, exact versions, hashes, sizes and identities.
# Debian repositories are used only here, never in the Ubuntu runtime.
FROM oh-python AS debian-inputs
ARG TARGETARCH
ARG BUILDARCH
ARG OPEN_HARNESS_BUILD_MODE
RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    sh /opt/open-harness-build/helpers/check-native-platform.sh \
 && python3 /opt/open-harness-build/helpers/debian_inputs.py configure-snapshot \
      --lock /opt/open-harness-build/lock/runtime-inputs.lock.json --arch "$TARGETARCH" > /etc/apt/sources.list.d/debian.sources \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get -o Acquire::Retries=0 update \
 && python3 /opt/open-harness-build/helpers/debian_inputs.py fetch \
      --lock /opt/open-harness-build/lock/runtime-inputs.lock.json --arch "$TARGETARCH" --out /out \
 && chmod -R a+rX /out \
 && rm -rf /var/lib/apt/lists/*

# curl with HTTP/3: signed Ubuntu source and build dependencies (network), then the tested three-file packaging
# change and the unchanged distribution build, both flavours and their tests as a non-root builder, offline.
FROM oh-ubuntu AS curl-builder
ARG TARGETARCH
ARG BUILDARCH
ARG OPEN_HARNESS_BUILD_MODE
RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    sh /opt/open-harness-build/helpers/check-native-platform.sh \
 && sh /opt/open-harness-build/helpers/ubuntu-snapshot.sh 20260929T180000Z /opt/open-harness-build/lock/ubuntu-os-packages.txt \
 && sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get -o Acquire::Retries=0 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y --no-install-recommends build-dep curl=8.18.0-1ubuntu2.7 \
 && DEBIAN_FRONTEND=noninteractive apt-get -y --no-install-recommends install libnghttp3-dev=1.12.0-1 pkg-config \
 && apt-get check \
 && mkdir -p /opt/build-provenance /work /out \
 && cp /var/lib/apt/lists/*InRelease /etc/apt/sources.list.d/ubuntu.sources /opt/build-provenance/ \
 && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > /opt/build-provenance/packages.tsv \
 && cd /work && apt-get -o Acquire::Retries=0 source --download-only curl=8.18.0-1ubuntu2.7 \
 && python3 /opt/open-harness-build/helpers/curl_http3.py verify-source \
      --lock /opt/open-harness-build/lock/runtime-inputs.lock.json --dir /work \
 && useradd -m -u 10001 -s /bin/bash builder \
 && chown -R 10001:10001 /work /out && chmod -R a+rX /opt/build-provenance \
 && rm -rf /var/lib/apt/lists/*
USER builder
WORKDIR /work
# The builder checks uid 10001, only loopback up, a visible pids limit of at least 2048 and no DEB_* variables.
RUN --network=none \
    --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    python3 /opt/open-harness-build/helpers/curl_http3.py build \
      --lock /opt/open-harness-build/lock/runtime-inputs.lock.json --work /work --out /out \
      --builder-provenance /opt/build-provenance

FROM oh-ubuntu AS runtime
ARG TARGETARCH
ARG BUILDARCH
ARG OPEN_HARNESS_BUILD_MODE
LABEL dev.openharness.build.mode=$OPEN_HARNESS_BUILD_MODE
# The exact manual package list of root's tested OS candidate (tools, desktop, libtk8.6, Python's libraries).
RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    sh /opt/open-harness-build/helpers/check-native-platform.sh \
 && sh /opt/open-harness-build/helpers/ubuntu-snapshot.sh 20260929T180000Z /opt/open-harness-build/lock/ubuntu-os-packages.txt \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive xargs --no-run-if-empty --delimiter='\n' \
      --arg-file=/opt/open-harness-build/lock/ubuntu-os-packages.txt \
      apt-get install -y --no-install-recommends \
 && apt-get check \
 && rm -rf /var/lib/apt/lists/*
# The three rebuilt runtime packages (not the dev, doc or debug ones), kept with their build provenance as in
# the tested image, and their one new dependency.
RUN --mount=type=bind,from=curl-builder,source=/out,target=/mnt/curl-http3 \
    mkdir -p /opt/open-harness/curl \
 && cp -R /mnt/curl-http3/debs /opt/open-harness/curl/packages \
 && cp -R /mnt/curl-http3/provenance /opt/open-harness/curl/provenance \
 && apt-get -o Acquire::Retries=0 update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libnghttp3-9=1.12.0-1 \
 && dpkg -i /opt/open-harness/curl/packages/curl_8.18.0-1ubuntu2.7+openharness.http3.1_${TARGETARCH}.deb \
      /opt/open-harness/curl/packages/libcurl4t64_8.18.0-1ubuntu2.7+openharness.http3.1_${TARGETARCH}.deb \
      /opt/open-harness/curl/packages/libcurl3t64-gnutls_8.18.0-1ubuntu2.7+openharness.http3.1_${TARGETARCH}.deb \
 && apt-get check \
 && chmod -R a+rX /opt/open-harness/curl \
 && rm -rf /var/lib/apt/lists/*
# Official Python 3.12.14 prefix; its native extensions were checked against these Ubuntu libraries.
COPY --from=oh-python /usr/local/ /usr/local/
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 PYTHON_VERSION=3.12.14
RUN ldconfig && python --version && python -m pip check
# Authenticated Debian chromium, chromium-common and libjpeg62-turbo. As in the tested image, the archives stay
# in the image with their signed-index metadata; the release gate re-verifies them against the lock instead of
# downloading them again. Their remaining dependencies are the pinned Ubuntu packages of the tested image.
RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    --mount=type=bind,from=debian-inputs,source=/out,target=/mnt/debian-inputs \
    mkdir -p /opt/open-harness/debian-browser/ubuntu-provenance \
 && cp -R /mnt/debian-inputs/packages /opt/open-harness/debian-browser/packages \
 && cp -R /mnt/debian-inputs/metadata /opt/open-harness/debian-browser/provenance \
 && apt-get -o Acquire::Retries=0 update \
 && /usr/local/bin/python3 /opt/open-harness-build/helpers/debian_inputs.py install-args \
      --lock /opt/open-harness-build/lock/runtime-inputs.lock.json --arch "$TARGETARCH" \
      --packages /opt/open-harness/debian-browser/packages > /tmp/open-harness-browser-install.txt \
 && DEBIAN_FRONTEND=noninteractive xargs --no-run-if-empty --delimiter='\n' \
      --arg-file=/tmp/open-harness-browser-install.txt apt-get install -y --no-install-recommends \
 && apt-get check && ldconfig \
 && cp /var/lib/apt/lists/*InRelease /opt/open-harness/debian-browser/ubuntu-provenance/ \
 && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > /opt/open-harness/debian-browser/ubuntu-provenance/packages.tsv \
 && chmod -R a+rX /opt/open-harness/debian-browser \
 && rm -rf /var/lib/apt/lists/* /tmp/open-harness-browser-install.txt
# Official Node 24.21.0 binary and npm tree with the Node license; npm becomes the verified 11.20.0.
COPY --from=oh-node /usr/local/bin/node /usr/local/bin/node
COPY --from=oh-node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=oh-node /usr/local/LICENSE /opt/open-harness/node/LICENSE
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g --registry=https://registry.npmjs.org npm@11.20.0 \
 && test "$(node --version)" = v24.21.0 && test "$(npm --version)" = 11.20.0 \
 && npm cache clean --force
RUN ln -s "$(dpkg-query -L libnss-wrapper | grep '/libnss_wrapper.so$')" /usr/local/lib/open-harness-nss-wrapper.so
ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
COPY runtime/hermes/security-constraints.txt runtime/hermes/apply-security-overrides.py /opt/open-harness/
# Client construction needs both SDKs, including Bedrock on local endpoints.
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent && git checkout "$HERMES_COMMIT" \
  && python /opt/open-harness/apply-security-overrides.py pyproject.toml \
  && pip install --no-cache-dir -c /opt/open-harness/security-constraints.txt -e '.[all,bedrock,anthropic]' \
  && pip check \
  && python -c "from tools.lazy_deps import feature_missing; missing = {name: feature_missing(name) for name in ('provider.vertex', 'provider.bedrock', 'provider.anthropic')}; assert not any(missing.values()), missing"
# These compile browser native addons; the MVP runtime supplies Python, Node and
# shell tools, not a system C/C++ development environment. Keep installer outputs.
RUN apt-get update && apt-get install -y --no-install-recommends make g++ \
  && npm install -g --allow-scripts=@askjo/camofox-browser,agent-browser,better-sqlite3 \
    agent-browser@0.37.1 @askjo/camofox-browser@1.16.0 \
  && apt-get purge -y --auto-remove make g++ \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 hermes && mkdir -p /workspace/private /workspace/shared /home/hermes/.hermes \
  && chown -R hermes:hermes /workspace /home/hermes \
  && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
# Production agents use the coordinator UID and a private HOME, not /home/hermes.
ARG CUA_DRIVER_VERSION=0.28.2
RUN CUA_DRIVER_RS_VERSION="$CUA_DRIVER_VERSION" CUA_DRIVER_RS_HOME=/opt/cua-driver CUA_DRIVER_BIN_DIR=/usr/local/bin hermes computer-use install \
  && test "$(cua-driver --version)" = "cua-driver $CUA_DRIVER_VERSION" \
  && chmod -R a+rX /opt/cua-driver
# The slim Python image ships _tkinter but not its Tcl/Tk runtime libraries.
# The coordinator UID must also traverse the parent of its private profile mount.
RUN apt-get update && apt-get install -y --no-install-recommends libtk8.6 \
  && rm -rf /var/lib/apt/lists/* \
  && chmod 0755 /home/hermes
# Keep frequently changed managed-policy files after the expensive upstream layers.
COPY runtime/hermes/ /opt/open-harness/
RUN chmod -R a+rX /opt/open-harness && chmod a+x /opt/open-harness/container-init.sh \
  && pip install --no-cache-dir -c /opt/open-harness/security-constraints.txt /opt/open-harness/extension \
  && pip check
USER hermes
ENV HERMES_HOME=/home/hermes/.hermes HERMES_TUI=1 PYTHONUNBUFFERED=1 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/open-harness-session-bus
WORKDIR /workspace/shared
# Read by Open Harness to tell whether this image predates a fix; must equal
# RUNTIME_CONTRACT in runtime/readiness.ts. Last so bumping it invalidates nothing heavier.
ARG OPEN_HARNESS_RUNTIME=7
USER root
RUN printf '%s\n' "$OPEN_HARNESS_RUNTIME" > /opt/open-harness/runtime-contract
USER hermes
LABEL dev.openharness.runtime=$OPEN_HARNESS_RUNTIME
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/open-harness/container-init.sh"]

# Build-time verification. The final stage copies its report, so the default target cannot skip it.
FROM runtime AS verify
ARG TARGETARCH
USER root
RUN --network=none \
    --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    --mount=type=bind,from=debian-inputs,source=/out,target=/mnt/debian-inputs \
    set -eu; \
    helpers=/opt/open-harness-build/helpers; lock=/opt/open-harness-build/lock; out=/out/verification; \
    mkdir -p "$out"; \
    /usr/local/bin/python3 "$helpers/check_packages.py" --lock "$lock/runtime-inputs.lock.json" --arch "$TARGETARCH" \
      --os-packages "$lock/ubuntu-os-packages.txt" --report "$out/packages.json"; \
    curl --version > "$out/curl-version.txt"; \
    /usr/local/bin/python3 "$helpers/curl_http3.py" check-runtime --lock "$lock/runtime-inputs.lock.json" \
      --arch "$TARGETARCH" --version-file "$out/curl-version.txt"; \
    /usr/local/bin/python3 "$helpers/elf_arch.py" --expect "$TARGETARCH" --linkage --report "$out/native-files.json" \
      /usr/bin/curl /usr/local/bin/python3.12 /usr/local/bin/node /usr/local/lib/open-harness-nss-wrapper.so \
      /usr/local/lib/python3.12/lib-dynload /usr/lib/chromium; \
    /usr/local/bin/python3 "$helpers/debian_origin.py" record --lock "$lock/runtime-inputs.lock.json" --arch "$TARGETARCH" \
      --root / --packages /opt/open-harness/debian-browser/packages \
      --debian-os-release /mnt/debian-inputs/debian-os/os-release \
      --debian-version /mnt/debian-inputs/debian-os/debian_version \
      --out "$out/debian-origin-inventory.json"; \
    chmod -R a+rX "$out"

FROM runtime AS verified-runtime
COPY --from=verify /out/verification/ /opt/open-harness/verification/
