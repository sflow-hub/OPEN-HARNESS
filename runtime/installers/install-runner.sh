#!/bin/sh
set -eu

coordinator="${OPEN_HARNESS_COORDINATOR:-}"
pairing_code="${OPEN_HARNESS_PAIRING_CODE:-}"
sites_token="${OPEN_HARNESS_SITES_TOKEN:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --coordinator) coordinator="$2"; shift 2 ;;
    --pairing-code) pairing_code="$2"; shift 2 ;;
    --sites-token) sites_token="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$coordinator" ] && [ -n "$pairing_code" ] || { echo "The coordinator address and pairing code are required." >&2; exit 2; }

install_dir="${OPEN_HARNESS_RUNNER_DIR:-$HOME/.local/share/open-harness-runner}"
state_dir="${OPEN_HARNESS_RUNNER_STATE_DIR:-$HOME/.open-harness-runner}"
node_version="v22.23.2"
os_name="$(uname -s)"
cpu="$(uname -m)"
case "$os_name:$cpu" in
  Linux:x86_64) node_platform="linux-x64" ;;
  Linux:aarch64|Linux:arm64) node_platform="linux-arm64" ;;
  Darwin:x86_64) node_platform="darwin-x64" ;;
  Darwin:arm64) node_platform="darwin-arm64" ;;
  *) echo "Open Harness does not have a runner for $os_name $cpu yet." >&2; exit 1 ;;
esac

echo "Installing Open Harness runner…"
mkdir -p "$install_dir/runtime/hermes/extension" "$state_dir"
node_bin="$install_dir/node/bin/node"
if [ ! -x "$node_bin" ]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl -fL --retry 3 "https://nodejs.org/dist/$node_version/node-$node_version-$node_platform.tar.gz" -o "$temp_dir/node.tar.gz"
  mkdir -p "$install_dir/node"
  tar -xzf "$temp_dir/node.tar.gz" -C "$install_dir/node" --strip-components=1
fi

download() {
  if [ -n "$sites_token" ]; then
    curl -fL --retry 3 -H "OAI-Sites-Authorization: Bearer $sites_token" "$coordinator/v1/install/file?path=$1" -o "$install_dir/$1"
  else
    curl -fL --retry 3 "$coordinator/v1/install/file?path=$1" -o "$install_dir/$1"
  fi
}
download "runtime/runner.mjs"
for file in Dockerfile NOTICE.md container-init.sh coordination.mjs inspect_runtime.py managed_entry.py extension/open_harness_policy.py extension/pyproject.toml; do
  download "runtime/hermes/$file"
done
chmod 700 "$install_dir/runtime/hermes/container-init.sh"

if docker version >/dev/null 2>&1 && ! docker image inspect open-harness-hermes:2026.9.11 >/dev/null 2>&1; then
  echo "Preparing the private agent workspace. This first-time step can take several minutes…"
  docker build -f "$install_dir/runtime/hermes/Dockerfile" -t open-harness-hermes:2026.9.11 "$install_dir"
fi
if ! docker image inspect open-harness-hermes:2026.9.11 >/dev/null 2>&1 && ! (python3 -c 'import hermes_cli, open_harness_policy' >/dev/null 2>&1 || python -c 'import hermes_cli, open_harness_policy' >/dev/null 2>&1); then
  echo "Docker is required for private agent workspaces. Install Docker, start it, then run this pairing command again: https://docs.docker.com/engine/install/" >&2
  exit 1
fi

if [ -n "$sites_token" ]; then
  OPEN_HARNESS_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$install_dir/runtime/runner.mjs" --coordinator "$coordinator" --pairing-code "$pairing_code" --sites-token "$sites_token" --once 1
else
  OPEN_HARNESS_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$install_dir/runtime/runner.mjs" --coordinator "$coordinator" --pairing-code "$pairing_code" --once 1
fi

if [ "$os_name" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$service_dir"
  cat > "$service_dir/open-harness-runner.service" <<EOF
[Unit]
Description=Open Harness runner
After=network-online.target docker.service

[Service]
Type=simple
Environment=OPEN_HARNESS_RUNNER_STATE_DIR=$state_dir
ExecStart=$node_bin $install_dir/runtime/runner.mjs
Restart=always
RestartSec=3
PassEnvironment=DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS

[Install]
WantedBy=default.target
EOF
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now open-harness-runner.service
  echo "Installed. The runner starts automatically for this user."
  if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "${USER:-}" --property=Linger --value 2>/dev/null || true)" != "yes" ]; then
    echo "For an always-on VPS, an administrator can run: loginctl enable-linger ${USER:-your-user}"
  fi
elif [ "$os_name" = "Darwin" ]; then
  service_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$service_dir"
  cat > "$service_dir/dev.openharness.runner.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>dev.openharness.runner</string><key>ProgramArguments</key><array><string>$node_bin</string><string>$install_dir/runtime/runner.mjs</string></array><key>EnvironmentVariables</key><dict><key>OPEN_HARNESS_RUNNER_STATE_DIR</key><string>$state_dir</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/dev.openharness.runner" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$service_dir/dev.openharness.runner.plist"
  echo "Installed. The runner starts automatically when you sign in."
else
  nohup env OPEN_HARNESS_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$install_dir/runtime/runner.mjs" > "$state_dir/runner.log" 2>&1 &
  echo "Installed. Keep this user session running so the runner stays connected."
fi
