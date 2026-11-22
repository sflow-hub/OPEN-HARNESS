#!/bin/sh
set -eu
umask 077
export PI_CODING_AGENT_DIR=/home/agent/.pi-managed
mkdir -p "$PI_CODING_AGENT_DIR"
cp /run/open-harness/models.json "$PI_CODING_AGENT_DIR/models.json"
exec "$@"
