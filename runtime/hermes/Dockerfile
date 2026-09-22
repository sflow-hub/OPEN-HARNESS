FROM python:3.12-slim-bookworm

ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
RUN apt-get update && apt-get install -y --no-install-recommends git curl ripgrep nodejs npm chromium ca-certificates tini xvfb openbox dbus-x11 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent && git checkout "$HERMES_COMMIT" \
  && pip install --no-cache-dir -e '.[all]'
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g \
  --allow-scripts=@askjo/camofox-browser,agent-browser,better-sqlite3 \
  agent-browser@0.37.1 @askjo/camofox-browser@1.16.0
RUN useradd -m -u 10001 hermes && mkdir -p /workspace/private /workspace/shared /home/hermes/.hermes \
  && chown -R hermes:hermes /workspace /home/hermes
USER hermes
ENV HERMES_HOME=/home/hermes/.hermes HERMES_TUI=1 PYTHONUNBUFFERED=1
RUN hermes computer-use install
# Everything above is upstream and rarely changes. Open Harness's own files come last so
# that an edit to runtime/hermes/ rebuilds only these layers instead of re-cloning Hermes,
# re-running pip install .[all] and reinstalling the browsers.
USER root
COPY runtime/hermes/ /opt/open-harness/
RUN chmod +x /opt/open-harness/container-init.sh \
  && pip install --no-cache-dir /opt/open-harness/extension
USER hermes
WORKDIR /workspace/shared
# Read by Open Harness to tell whether this image predates a fix; must equal
# RUNTIME_CONTRACT in runtime/readiness.ts. Last so bumping it invalidates nothing heavier.
ARG OPEN_HARNESS_RUNTIME=2
LABEL dev.openharness.runtime=$OPEN_HARNESS_RUNTIME
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/open-harness/container-init.sh"]
