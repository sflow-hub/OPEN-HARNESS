#!/bin/bash
# Double-click launcher for macOS. Runs launchers/start.sh from this folder and keeps
# the Terminal window open so the result can be read. See docs/LOCAL_BROWSER.md.
cd "$(dirname "$0")" || exit 64
OPEN_HARNESS_LAUNCHER_PAUSE=1 exec /bin/bash "launchers/start.sh" "$@"
