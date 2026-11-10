#!/bin/sh
set -eu
if [ "${OPEN_HARNESS_VIRTUAL_DESKTOP:-}" = "1" ] && [ "${OPEN_HARNESS_RUNTIME_ROLE:-desktop}" = "desktop" ]; then
  # Docker restart can leave socket/lock files after killing the old processes.
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/open-harness-session-bus
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  attempts=0
  until xdpyinfo -display :99 >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      cat /tmp/xvfb.log >&2
      echo 'The private virtual display did not start.' >&2
      exit 1
    fi
    sleep 0.1
  done
  # Docker exec inherits the image environment, so use a stable private bus path.
  # DBus needs passwd/group entries for the coordinator UID, which may differ
  # from the image user. Keep that compatibility shim scoped to the session bus.
  umask 077
  cat /etc/passwd > /tmp/open-harness-passwd
  cat /etc/group > /tmp/open-harness-group
  uid=$(id -u)
  gid=$(id -g)
  getent passwd "$uid" >/dev/null || printf 'agent:x:%s:%s:Private agent:%s:/bin/sh\n' "$uid" "$gid" "$HOME" >> /tmp/open-harness-passwd
  getent group "$gid" >/dev/null || printf 'agent:x:%s:\n' "$gid" >> /tmp/open-harness-group
  LD_PRELOAD=/usr/local/lib/open-harness-nss-wrapper.so \
    NSS_WRAPPER_PASSWD=/tmp/open-harness-passwd NSS_WRAPPER_GROUP=/tmp/open-harness-group \
    dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork
  # Chromium decides whether to expose accessibility when it starts. Enable the
  # private session first, including browsers opened before the computer tool.
  for property in IsEnabled ScreenReaderEnabled; do
    dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus \
      org.freedesktop.DBus.Properties.Set string:org.a11y.Status "string:$property" variant:boolean:true >/dev/null
  done
  # The terminal is a scoped browser client. No desktop menu may launch an
  # untracked shell outside the execution container's termination boundary.
  cat > /tmp/open-harness-openbox.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <desktops><number>1</number></desktops>
  <keyboard>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
    <keybind key="A-F4"><action name="Close"/></keybind>
  </keyboard>
  <mouse><context name="Titlebar">
    <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
    <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
  </context></mouse>
</openbox_config>
EOF
  DISPLAY=:99 openbox --config-file /tmp/open-harness-openbox.xml >/tmp/openbox.log 2>&1 &
fi
if [ "${1:-}" = "--init-only" ]; then exit 0; fi
if [ "${OPEN_HARNESS_RUNTIME_ROLE:-}" = "desktop" ]; then
  close_browser() {
    python /opt/open-harness/browser_shutdown.py --timeout 6 || true
    exit 0
  }
  trap close_browser TERM INT
  while :; do sleep 3600 & wait $! || true; done
fi
exec sleep infinity
