#!/bin/sh
set -eu

coordinator="${OPEN_HARNESS_COORDINATOR:-}"
pairing_code="${OPEN_HARNESS_PAIRING_CODE:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --coordinator) coordinator="$2"; shift 2 ;;
    --pairing-code) pairing_code="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$coordinator" ] && [ -n "$pairing_code" ] || { echo "The coordinator address and pairing code are required." >&2; exit 2; }

install_dir="${OPEN_HARNESS_RUNNER_DIR:-$HOME/.local/share/open-harness-runner}"
state_dir="${OPEN_HARNESS_RUNNER_STATE_DIR:-$HOME/.open-harness-runner}"
hermes_image="${OPEN_HARNESS_HERMES_IMAGE:-open-harness-hermes:2026.9.11}"
case "$hermes_image" in ''|*[!a-zA-Z0-9._:/@-]*) echo "Invalid Hermes image name." >&2; exit 2 ;; esac
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
mkdir -p "$install_dir/runtime/hermes/extension" "$install_dir/runtime/ubuntu/helpers" "$install_dir/runtime/ubuntu/lock" "$state_dir"
node_bin="$install_dir/node/bin/node"
if [ ! -x "$node_bin" ]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl -fL --retry 3 "https://nodejs.org/dist/$node_version/node-$node_version-$node_platform.tar.gz" -o "$temp_dir/node.tar.gz"
  mkdir -p "$install_dir/node"
  tar -xzf "$temp_dir/node.tar.gz" -C "$install_dir/node" --strip-components=1
fi

download() {
  curl -fL --retry 3 "$coordinator/v1/install/file?path=$1" -o "$install_dir/$1"
}
download "runtime/runner.mjs"
for file in Dockerfile NOTICE.md container-init.sh cua_compat.py coordination.mjs inspect_runtime.py managed_entry.py security-constraints.txt apply-security-overrides.py extension/open_harness_policy.py extension/pyproject.toml; do
  download "runtime/hermes/$file"
done
for file in helpers/check-native-platform.sh helpers/ubuntu-snapshot.sh helpers/check_packages.py helpers/curl_http3.py helpers/debian_inputs.py helpers/debian_origin.py helpers/elf_arch.py helpers/ohpkg.py lock/runtime-inputs.lock.json lock/ubuntu-os-packages.txt; do
  download "runtime/ubuntu/$file"
done
chmod 700 "$install_dir/runtime/hermes/container-init.sh"

runtime_contract="$(sed -n 's/^ARG OPEN_HARNESS_RUNTIME=//p' "$install_dir/runtime/hermes/Dockerfile")"
case "$runtime_contract" in ''|*[!0-9]*) echo "The downloaded runtime has no valid contract version." >&2; exit 1 ;; esac
runtime_current() {
  [ "$(docker image inspect -f '{{index .Config.Labels "dev.openharness.runtime"}}' "$hermes_image" 2>/dev/null || true)" = "$runtime_contract" ]
}
if docker version >/dev/null 2>&1 && ! runtime_current; then
  echo "Preparing the private agent workspace. This first-time step can take several minutes…"
  docker build -f "$install_dir/runtime/hermes/Dockerfile" -t "$hermes_image" "$install_dir"
fi
if ! runtime_current; then
  echo "Docker is required for private agent workspaces. Install Docker, start it, then run this pairing command again: https://docs.docker.com/engine/install/" >&2
  exit 1
fi

OPEN_HARNESS_HERMES_IMAGE="$hermes_image" OPEN_HARNESS_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$install_dir/runtime/runner.mjs" --coordinator "$coordinator" --pairing-code "$pairing_code" --once 1

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
Environment=OPEN_HARNESS_HERMES_IMAGE=$hermes_image
ExecStart=$node_bin $install_dir/runtime/runner.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
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
<plist version="1.0"><dict><key>Label</key><string>dev.openharness.runner</string><key>ProgramArguments</key><array><string>$node_bin</string><string>$install_dir/runtime/runner.mjs</string></array><key>EnvironmentVariables</key><dict><key>OPEN_HARNESS_RUNNER_STATE_DIR</key><string>$state_dir</string><key>OPEN_HARNESS_HERMES_IMAGE</key><string>$hermes_image</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/dev.openharness.runner" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$service_dir/dev.openharness.runner.plist"
  echo "Installed. The runner starts automatically when you sign in."
else
  nohup env OPEN_HARNESS_HERMES_IMAGE="$hermes_image" OPEN_HARNESS_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$install_dir/runtime/runner.mjs" > "$state_dir/runner.log" 2>&1 &
  echo "Installed. Keep this user session running so the runner stays connected."
fi
