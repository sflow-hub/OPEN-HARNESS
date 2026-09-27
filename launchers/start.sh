#!/bin/bash
# Open Harness — local browser launcher for macOS (and Linux).
#
# Starts the Docker-backed Open Harness stack from a downloaded release directory
# and opens the dashboard in the default browser once it is healthy. Needs only
# Docker Desktop (or another Docker engine with Compose v2): no Node, Python or
# Git on the host. Written for /bin/bash 3.2, which is what macOS ships.
#
#   launchers/start.sh [--no-open] [--build] [--override <compose-override-file>]
#                      [--timeout <seconds>] [--stop | --status | --logs | --help]
#
# Exit codes: 0 ok · 2 Docker missing, not startable or not a Linux engine ·
# 3 Compose failed · 4 the app did not become healthy in time · 5 the stack is
# up but the paired browser window could not be opened · 64 usage.
set -u

# ---------------------------------------------------------------- locate ----
# The release directory is the parent of this script's directory, wherever the
# archive was extracted and whatever its path contains (spaces included).
script_dir=$(cd "$(dirname "$0")" && pwd)
release_dir=$(cd "$script_dir/.." && pwd)
log_file="$release_dir/open-harness-launcher.log"
app_url="http://localhost:3000"
health_url=${OPEN_HARNESS_HEALTH_URL:-http://127.0.0.1:3000/api/health}
compose_file="compose.yaml"
lock_file="image-lock.json"

timeout_seconds=${OPEN_HARNESS_LAUNCHER_TIMEOUT:-300}
open_browser=1
build=0
override_file=""
action="start"

# ----------------------------------------------------------------- output ----
say() { printf '%s\n' "$*"; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file" 2>/dev/null || true; }
warn() { printf '%s\n' "$*" >&2; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file" 2>/dev/null || true; }
hints() {
  warn "Look at:  cd \"$release_dir\" && docker compose ps"
  warn "          cd \"$release_dir\" && docker compose logs --tail=100 open-harness"
  warn "Launcher log: $log_file"
}
pause_if_wrapped() { if [ "${OPEN_HARNESS_LAUNCHER_PAUSE:-0}" = "1" ] && [ -t 0 ]; then printf 'Press Return to close this window. '; read -r _ignored || true; fi; }
fail() { code=$1; shift; warn "$*"; hints; pause_if_wrapped; exit "$code"; }
usage() {
  cat <<'USAGE'
Usage: launchers/start.sh [options]

  (no option)          Start Open Harness and open a paired browser window.
  --no-open            Start and wait for health, but do not mint a pairing code
                       or open a browser (for scripts and acceptance runs).
  --build              Development only: build the coordinator image from the
                       source tree next to compose.yaml instead of using the
                       pinned release image.
  --override <file>    Add an explicitly chosen Compose override file, such as
                       your edited copy of compose.host-folders.example.yaml.
                       Nothing on this computer is shared without it.
  --timeout <seconds>  How long to wait for Docker to start and for the app to
                       become healthy (default 300, or OPEN_HARNESS_LAUNCHER_TIMEOUT).
  --stop               Stop the stack. Your data stays in its Docker volumes.
  --status             Show the containers and whether the app answers.
  --logs               Show recent coordinator logs.
  --help               This text.
USAGE
}

# ------------------------------------------------------------ arguments ----
while [ $# -gt 0 ]; do
  case "$1" in
    --no-open) open_browser=0 ;;
    --build) build=1 ;;
    --override|--folders)
      [ $# -ge 2 ] || { usage; exit 64; }
      override_file=$2; shift ;;
    --timeout)
      [ $# -ge 2 ] || { usage; exit 64; }
      timeout_seconds=$2; shift ;;
    --stop) action="stop" ;;
    --status) action="status" ;;
    --logs) action="logs" ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done
case "$timeout_seconds" in ''|*[!0-9]*) usage; exit 64 ;; esac

cd "$release_dir" || fail 64 "Could not enter the release directory: $release_dir"
say "Open Harness launcher starting in: $release_dir"

# ------------------------------------------------------- release contract ----
for required in "$compose_file" "$lock_file" "runtime/dind-entrypoint.sh"; do
  [ -f "$required" ] || fail 64 "This does not look like a complete Open Harness release: $required is missing from $release_dir. Extract the whole archive and run the launcher from inside it."
done
if [ -n "$override_file" ]; then
  [ -f "$override_file" ] || fail 64 "The folder override file does not exist: $override_file"
fi
if [ "$build" = "1" ] && [ ! -f "Dockerfile.coordinator" ]; then
  fail 64 "--build needs the source tree (Dockerfile.coordinator) next to compose.yaml. A downloaded browser release uses the pinned images and does not need it."
fi

# A downloaded release ships compose.yaml with every image pinned by digest and
# OPEN_HARNESS_HERMES_PULL=1 already set, and image-lock.json records the same
# digests for the package validator; the launcher does not rewrite any of them.
# --build is the source tree's own path: the coordinator is built here and the
# Hermes image is prepared locally, so pulling is switched off explicitly.
if [ "$build" = "1" ]; then export OPEN_HARNESS_HERMES_PULL=0; fi

# ------------------------------------------------------------- platform ----
platform=${OPEN_HARNESS_LAUNCHER_PLATFORM:-$(uname -s 2>/dev/null || echo unknown)}
case "$platform" in Darwin|darwin) platform=darwin ;; Linux|linux) platform=linux ;; *) platform=other ;; esac

docker_app=${OPEN_HARNESS_DOCKER_APP:-/Applications/Docker.app}
docker_desktop_installed() { [ "$platform" = darwin ] && [ -d "$docker_app" ]; }
docker_cli_missing_message() {
  if [ "$platform" = darwin ]; then
    if docker_desktop_installed; then
      echo "Docker Desktop is installed but its command-line tools are not on PATH yet. Open Docker Desktop once and finish its setup, then run this launcher again."
    else
      echo "Docker Desktop is not installed. Download it from https://www.docker.com/products/docker-desktop/ (choose Apple silicon or Intel to match this Mac), open it once, then run this launcher again."
    fi
  else
    echo "Docker is not installed or not on PATH. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Docker Engine with the Compose plugin, then run this launcher again."
  fi
}
daemon_ready() { docker info >/dev/null 2>&1; }

command -v docker >/dev/null 2>&1 || fail 2 "$(docker_cli_missing_message)"

if ! daemon_ready; then
  if docker_desktop_installed; then
    say "Docker Desktop is not running. Starting it…"
    open -gja Docker >/dev/null 2>&1 || warn "Could not ask macOS to open Docker Desktop; waiting in case it is starting on its own."
  elif [ "$platform" = darwin ]; then
    fail 2 "$(docker_cli_missing_message)"
  else
    say "Docker is installed but not running. Start it (Docker Desktop, or 'sudo systemctl start docker' on a server) — waiting up to $timeout_seconds seconds."
  fi
  waited=0
  until daemon_ready; do
    [ "$waited" -lt "$timeout_seconds" ] || fail 2 "Docker did not become ready within $timeout_seconds seconds. Open Docker Desktop, wait for its whale icon to settle, then run this launcher again."
    sleep 2; waited=$((waited + 2))
  done
  say "Docker is ready."
fi

engine_os=$(docker info --format '{{.OSType}}' 2>/dev/null | tr -d '\r')
[ "$engine_os" = "linux" ] || fail 2 "Docker is running $engine_os containers, but Open Harness needs Linux containers. In Docker Desktop choose 'Switch to Linux containers…' from its menu, then run this launcher again."
docker compose version >/dev/null 2>&1 || fail 2 "Docker Compose v2 ('docker compose') is not available. Update Docker Desktop, which includes it, then run this launcher again."

# --------------------------------------------------------------- compose ----
# Every Compose call uses the same file list so an override chosen once applies
# to up, stop, ps and logs alike.
compose() {
  if [ -n "$override_file" ]; then docker compose -f "$compose_file" -f "$override_file" "$@"; else docker compose -f "$compose_file" "$@"; fi
}
healthy() {
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$health_url" 2>/dev/null || echo 000)
  [ "$status" = "200" ]
}

case "$action" in
  stop)
    say "Stopping Open Harness. Your agents, conversations and credentials stay in Docker volumes."
    compose stop || fail 3 "Docker Compose could not stop the stack."
    say "Stopped. Run this launcher again to start it."
    pause_if_wrapped; exit 0 ;;
  status)
    compose ps || fail 3 "Docker Compose could not list the stack."
    if healthy; then say "The app answers at $app_url"; else say "The app is not answering at $app_url yet."; fi
    pause_if_wrapped; exit 0 ;;
  logs)
    compose logs --tail=200 || fail 3 "Docker Compose could not read the logs."
    pause_if_wrapped; exit 0 ;;
esac

if [ "$build" = "1" ]; then
  say "Building the coordinator image from source and starting the Open Harness containers…"
  compose up -d --build || fail 3 "Docker Compose could not build and start the stack."
else
  say "Downloading the pinned Open Harness images (the first start can take several minutes)…"
  compose pull || fail 3 "Docker Compose could not download the pinned images. Check your internet connection and that Docker Desktop is signed in if your registry needs it, then run this launcher again."
  say "Starting the Open Harness containers…"
  compose up -d --no-build || fail 3 "Docker Compose could not start the stack."
fi

say "Waiting for the app to become healthy (up to $timeout_seconds seconds)…"
waited=0
until healthy; do
  [ "$waited" -lt "$timeout_seconds" ] || fail 4 "The app did not answer at $health_url within $timeout_seconds seconds. The containers are still running and your data is intact."
  sleep 2; waited=$((waited + 2))
done

# --------------------------------------------------------------- pairing ----
# The dashboard hands out its operator token only to a browser that presents a
# one-use code minted inside the coordinator container. The code travels in the
# URL fragment (never sent to a server), is consumed by the page on load, and is
# never printed here.
urlencode() {
  value=$1; encoded=""; i=0
  while [ "$i" -lt "${#value}" ]; do
    c=${value:$i:1}
    case "$c" in
      [A-Za-z0-9._~-]) encoded="$encoded$c" ;;
      *) encoded="$encoded$(printf '%%%02X' "'$c")" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$encoded"
}
open_url() {
  if [ -n "${OPEN_HARNESS_BROWSER_COMMAND:-}" ]; then "$OPEN_HARNESS_BROWSER_COMMAND" "$1" >/dev/null 2>&1
  elif [ "$platform" = darwin ]; then open "$1" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  else return 1; fi
}

if [ "$open_browser" = "0" ]; then
  say "Open Harness is running at $app_url"
  say "No browser was opened (--no-open). To pair one, mint a code with: docker compose -f $compose_file exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs — then open $app_url/#pair=<code>."
  pause_if_wrapped; exit 0
fi

pair_json=$(compose exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs 2>/dev/null)
pair_code=$(printf '%s' "$pair_json" | tr -d '\n\r' | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -n "$pair_code" ]; then
  target="$app_url/#pair=$(urlencode "$pair_code")"
  if open_url "$target"; then
    say "Open Harness is running at $app_url — a paired browser window is opening."
  else
    fail 5 "Open Harness is running at $app_url, but no browser could be opened from here. Run the launcher again from a desktop session, or open $app_url and follow the pairing instructions shown there."
  fi
else
  warn "Could not mint a browser pairing code (is this release's coordinator image current?). Opening the dashboard without one; it will say if pairing is required."
  open_url "$app_url" || fail 5 "Open Harness is running at $app_url, but no browser could be opened from here."
fi
pause_if_wrapped
exit 0
