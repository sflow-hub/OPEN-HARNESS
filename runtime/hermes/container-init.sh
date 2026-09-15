#!/bin/sh
set -eu
if [ "${OPEN_HARNESS_VIRTUAL_DESKTOP:-}" = "1" ]; then
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  openbox --display :99 >/tmp/openbox.log 2>&1 &
fi
exec sleep infinity
