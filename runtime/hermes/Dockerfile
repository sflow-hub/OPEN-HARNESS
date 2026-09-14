FROM python:3.12-slim-bookworm

ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
RUN apt-get update && apt-get install -y --no-install-recommends git curl ripgrep nodejs npm chromium ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent && git checkout "$HERMES_COMMIT" \
  && pip install --no-cache-dir -e '.[all]'
RUN npm install -g agent-browser @askjo/camofox-browser
COPY runtime/hermes/ /opt/open-harness/
RUN pip install --no-cache-dir /opt/open-harness/extension
RUN useradd -m -u 10001 hermes && mkdir -p /workspace/private /workspace/shared /home/hermes/.hermes \
  && chown -R hermes:hermes /workspace /home/hermes
USER hermes
WORKDIR /workspace/shared
ENV HERMES_HOME=/home/hermes/.hermes HERMES_TUI=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
