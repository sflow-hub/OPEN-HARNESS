FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS runtime
WORKDIR /tmp/atlas-build
COPY model-lock.json fetch-runtime.mjs ./
ARG TARGETARCH
RUN node fetch-runtime.mjs "$TARGETARCH"

FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 libgomp1 libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && command -v flock && install -d -o node -g node /models
COPY --from=runtime /opt/llama/ /opt/llama/
ENV LD_LIBRARY_PATH=/opt/llama
WORKDIR /opt/atlas
COPY --chmod=0644 *.mjs model-lock.json ./
USER node
RUN node --input-type=module -e "await import('./server.mjs')" && node --check worker-link.mjs \
    && ip -j -4 address show dev lo >/dev/null && /opt/llama/llama-server --version && test -w /models
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=4s --start-period=30m \
    CMD ["node","-e","fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/opt/atlas/server.mjs"]
