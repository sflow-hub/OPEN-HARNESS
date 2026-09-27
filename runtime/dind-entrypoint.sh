#!/bin/sh
set -eu

# DinD can be the first service to mount a fresh named volume, before the
# coordinator image's /data ownership is copied into it. Only initialize empty
# root-owned data; existing state requires the operator's explicit migration.
owner=$(stat -c '%u:%g' /data)
if [ "$owner" != '1000:1000' ]; then
  contents=$(find /data -mindepth 1 -maxdepth 1 -print -quit)
  if [ "$owner" = '0:0' ] && [ -z "$contents" ]; then
    chown 1000:1000 /data
  else
    echo 'Open Harness data must belong to UID/GID 1000. Stop the stack and follow the existing-volume migration in docs/SELF_HOSTING.md; existing data was not modified.' >&2
    exit 1
  fi
fi

# Preserve the official DinD setup, with the explicit Unix-only dockerd command
# supplied by compose.yaml. Never mount this control socket into an agent.
exec /usr/local/bin/dockerd-entrypoint.sh "$@"
