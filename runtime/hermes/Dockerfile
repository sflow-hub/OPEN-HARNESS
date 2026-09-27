FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS node-runtime
FROM python:3.12.14-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
RUN apt-get update && apt-get install -y --no-install-recommends git curl ripgrep chromium ca-certificates tini xvfb openbox dbus-x11 x11-utils at-spi2-core libnss-wrapper libstdc++6 libatomic1 \
  && ln -s "$(dpkg-query -L libnss-wrapper | grep '/libnss_wrapper.so$')" /usr/local/lib/open-harness-nss-wrapper.so \
  && rm -rf /var/lib/apt/lists/*
# One Node distribution avoids retaining Debian npm's obsolete dependency tree.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && npm install -g npm@11.20.0 \
  && test "$(node --version)" = v24.21.0 && test "$(npm --version)" = 11.20.0 \
  && npm cache clean --force
COPY runtime/hermes/security-constraints.txt runtime/hermes/apply-security-overrides.py /opt/open-harness/
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent && git checkout "$HERMES_COMMIT" \
  && python /opt/open-harness/apply-security-overrides.py pyproject.toml \
  && pip install --no-cache-dir -c /opt/open-harness/security-constraints.txt -e '.[all]' \
  && pip check
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
ARG OPEN_HARNESS_RUNTIME=5
USER root
RUN printf '%s\n' "$OPEN_HARNESS_RUNTIME" > /opt/open-harness/runtime-contract
USER hermes
LABEL dev.openharness.runtime=$OPEN_HARNESS_RUNTIME
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/open-harness/container-init.sh"]
