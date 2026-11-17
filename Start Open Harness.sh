#!/bin/bash
dir=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1
if [ ! -t 0 ] && ! command -v zenity >/dev/null && ! command -v kdialog >/dev/null; then
  if command -v x-terminal-emulator >/dev/null; then exec x-terminal-emulator -e /bin/bash "$dir/launchers/start.sh" --desktop; fi
  if command -v gnome-terminal >/dev/null; then exec gnome-terminal -- /bin/bash "$dir/launchers/start.sh" --desktop; fi
fi
exec /bin/bash "$dir/launchers/start.sh" --desktop
