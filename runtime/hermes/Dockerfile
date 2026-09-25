FROM python:3.12-slim-bookworm

ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
RUN apt-get update && apt-get install -y --no-install-recommends git curl ripgrep nodejs npm chromium ca-certificates tini xvfb openbox dbus-x11 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent && git checkout "$HERMES_COMMIT" \
  && pip install --no-cache-dir -e '.[all]'
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs make g++ \
  && rm -rf /var/lib/apt/lists/*
# Keep browser files outside root's home; the default postinstall also hides download failures.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN CAMOFOX_SKIP_DOWNLOAD=1 npm install -g \
  --allow-scripts=@askjo/camofox-browser,agent-browser,better-sqlite3 \
  agent-browser@0.37.1 @askjo/camofox-browser@1.16.0 \
  && cd "$(npm root -g)/@askjo/camofox-browser" \
  && node --input-type=module -e 'import { CamoufoxFetcher } from "camoufox-js/dist/pkgman.js"; await new CamoufoxFetcher().install();' \
  && chmod -R a+rX "$CAMOUFOX_INSTALL_DIR"
COPY runtime/hermes/ /opt/open-harness/
RUN chmod +x /opt/open-harness/container-init.sh
RUN pip install --no-cache-dir /opt/open-harness/extension
RUN useradd -m -u 10001 hermes && mkdir -p /workspace/private /workspace/shared /home/hermes/.hermes \
  && chown -R hermes:hermes /workspace /home/hermes
USER hermes
ENV HERMES_HOME=/home/hermes/.hermes HERMES_TUI=1 PYTHONUNBUFFERED=1
RUN cd "$(npm root -g)/@askjo/camofox-browser" \
  && node --input-type=module -e 'import { accessSync, constants } from "node:fs"; import { camoufoxPath, launchPath } from "camoufox-js/dist/pkgman.js"; camoufoxPath(false); accessSync(launchPath(), constants.R_OK | constants.X_OK);' \
  && hermes computer-use install
WORKDIR /workspace/shared
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/open-harness/container-init.sh"]
