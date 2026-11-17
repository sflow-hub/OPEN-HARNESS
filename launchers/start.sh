#!/bin/bash
# Open Harness — local browser launcher for macOS (and Linux).
#
# Starts the Docker-backed Open Harness stack from a source folder or browser release
# and opens the dashboard in the default browser once it is healthy. Needs only
# Docker Desktop (or another Docker engine with Compose v2): no Node, Python or
# Git on the host. Written for /bin/bash 3.2, which is what macOS ships.
#
#   launchers/start.sh [--no-open] [--build] [--override <compose-override-file>]
#                      [--timeout <seconds>] [--stop | --status | --logs | --help]
#
# Exit codes: 0 ok · 2 Docker missing, not startable or not a Linux engine ·
# 3 Compose failed · 4 the app did not become healthy in time · 5 the stack is
# up and healthy but no paired browser window could be produced (no connection
# link could be minted, or no browser could be opened) · 64 usage.
set -u

# ---------------------------------------------------------------- locate ----
# The release directory is the parent of this script's directory, wherever the
# archive was extracted and whatever its path contains (spaces included).
script_dir=$(cd "$(dirname "$0")" && pwd)
release_dir=$(cd "$script_dir/.." && pwd)
log_file="$release_dir/open-harness-launcher.log"
dashboard_port=${OPEN_HARNESS_DASHBOARD_PORT:-3000}
case "$dashboard_port" in ''|*[!0-9]*|0*|??????*) echo 'Choose a dashboard port between 1 and 65535.' >&2; exit 64 ;; esac
[ "$dashboard_port" -le 65535 ] || { echo 'Choose a dashboard port between 1 and 65535.' >&2; exit 64; }
app_url="http://localhost:$dashboard_port"
health_url=${OPEN_HARNESS_HEALTH_URL:-http://127.0.0.1:$dashboard_port/api/health}
compose_file="compose.yaml"
lock_file="image-lock.json"

timeout_seconds=${OPEN_HARNESS_LAUNCHER_TIMEOUT:-300}
open_browser=1
build=0
override_file=""
action="start"
desktop=0
model_choice=""
setup_query=""
model_images_built=0
model_profile=()
preference_file=""
saved_model=""
dialog_method=terminal
progress_dialog=0

# ----------------------------------------------------------------- output ----
say() { printf '%s\n' "$*"; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file" 2>/dev/null || true; }
warn() { printf '%s\n' "$*" >&2; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file" 2>/dev/null || true; }
hints() {
  warn "Look at:  cd \"$release_dir\" && docker compose ps"
  warn "          cd \"$release_dir\" && docker compose logs --tail=100 open-harness"
  warn "Launcher log: $log_file"
}
pause_if_wrapped() { if [ "${OPEN_HARNESS_LAUNCHER_PAUSE:-0}" = "1" ] && [ -t 0 ]; then printf 'Press Return to close this window. '; read -r _ignored || true; fi; }
fail() {
  code=$1; shift; warn "$*"; hints
  if [ "$desktop" = 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then zenity --error --title='Open Harness' --text="$*" || :
    elif command -v kdialog >/dev/null 2>&1; then kdialog --title 'Open Harness' --error "$*" || :
    else OPEN_HARNESS_LAUNCHER_PAUSE=1; fi
  fi
  pause_if_wrapped; exit "$code"
}
usage() {
  cat <<'USAGE'
Usage: launchers/start.sh [options]

  (no option)          Start Open Harness and open a paired browser window.
  --no-open            Start and wait for health, but do not mint a pairing code
                       or open a browser (for scripts and acceptance runs).
  --build              Explicitly build from source. A source download is
                       recognized automatically when no option is supplied.
  --desktop            Linux: choose a local CPU model or your own provider.
  --local-model        Linux: download and use Atlas on this computer.
  --own-provider       Linux: use your own provider without a local download.
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
    --desktop) desktop=1 ;;
    --local-model) model_choice=local ;;
    --own-provider) model_choice=provider ;;
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
# Source ZIPs contain the coordinator source and Dockerfile but no Git metadata.
# A missing release lock alone must never select a source build.
for required in "$compose_file" "runtime/dind-entrypoint.sh"; do
  [ -f "$required" ] || fail 64 "This does not look like a complete Open Harness release: $required is missing from $release_dir. Extract the whole archive and run the launcher from inside it."
done
source_tree() { [ -f "Dockerfile.coordinator" ] && [ -f "runtime/service.ts" ]; }
if [ "$build" = "1" ]; then
  source_tree || fail 64 "--build needs the source folder containing Dockerfile.coordinator and runtime/service.ts. Extract the complete Open Harness source ZIP to build from source."
elif [ ! -e "$lock_file" ] && source_tree; then
  build=1
elif [ ! -f "$lock_file" ]; then
  fail 64 "$lock_file is missing or unreadable in $release_dir. Extract the whole browser release or the complete Open Harness source ZIP, then open its launcher."
fi
if [ -n "$override_file" ]; then
  [ -f "$override_file" ] || fail 64 "The folder override file does not exist: $override_file"
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

# Docker Desktop for Mac keeps its own copy of the CLI inside the app bundle. A
# fresh install, or a user-mode one, may not have put anything on PATH yet, so
# after the caller's PATH the bundle's bin directory (and ~/.docker/bin, where
# the user-mode install links the tools) is tried before Docker is declared
# missing. Appended, never prepended: whatever the operator has first stays first.
docker_app=${OPEN_HARNESS_DOCKER_APP:-}
if [ -z "$docker_app" ] && [ "$platform" = darwin ]; then
  for candidate in /Applications/Docker.app "$HOME/Applications/Docker.app"; do
    if [ -d "$candidate" ]; then docker_app=$candidate; break; fi
  done
fi
docker_desktop_installed() { [ "$platform" = darwin ] && [ -n "$docker_app" ] && [ -d "$docker_app" ]; }
if ! command -v docker >/dev/null 2>&1 && [ "$platform" = darwin ]; then
  for bin_dir in "${docker_app:+$docker_app/Contents/Resources/bin}" "$HOME/.docker/bin"; do
    if [ -n "$bin_dir" ] && [ -x "$bin_dir/docker" ]; then export PATH="$PATH:$bin_dir"; break; fi
  done
fi
docker_cli_missing_message() {
  if [ "$platform" = darwin ]; then
    if docker_desktop_installed; then
      echo "Docker Desktop is installed at $docker_app but no docker command was found on PATH or inside the app. Open Docker Desktop once and finish its setup, then run this launcher again."
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
if ! docker compose version >/dev/null 2>&1; then
  if docker_desktop_installed && [ -x "$docker_app/Contents/Resources/cli-plugins/docker-compose" ]; then
    fail 2 "Docker Desktop's Compose plugin is at $docker_app/Contents/Resources/cli-plugins but the docker command does not see it. Open Docker Desktop once so it registers its command-line plugins, then run this launcher again."
  fi
  fail 2 "Docker Compose v2 ('docker compose') is not available. Update Docker Desktop, which includes it, then run this launcher again."
fi

# --------------------------------------------------------------- compose ----
# Every Compose call uses the same file list so an override chosen once applies
# to up, stop, ps and logs alike.
compose() {
  if [ -n "$override_file" ]; then docker compose -f "$compose_file" -f "$override_file" ${model_profile[@]+"${model_profile[@]}"} "$@"; else docker compose -f "$compose_file" ${model_profile[@]+"${model_profile[@]}"} "$@"; fi
}
healthy() {
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$health_url" 2>/dev/null || echo 000)
  [ "$status" = "200" ]
}

if [ "$platform" = linux ]; then
  . "$script_dir/linux-model.sh"
  preference_file=$(model_state_file) || preference_file=''
  if [ -n "$preference_file" ] && [ -r "$preference_file" ]; then
    read -r saved_model < "$preference_file" || :
  fi
  if [ "$desktop" = 1 ] && [ "$action" = start ]; then
    dialog_method=$(model_dialog)
    if compose --profile atlas-model config --services 2>/dev/null | grep -qx atlas-model; then
      model_choice=$(choose_model "$saved_model" "$dialog_method") || exit 0
    fi
  fi
  # Only a choice made on this launch should open the dashboard's model setup.
  case "$model_choice" in local|provider) setup_query="?setupModel=$model_choice" ;; esac
  model_choice=${model_choice:-$saved_model}
  if [ "$action" = stop ]; then model_profile=(--profile atlas-model); fi
  case "$model_choice" in
    local)
      model_profile=(--profile atlas-model)
      export OPEN_HARNESS_BUNDLED_MODEL=1
      if [ "$action" = start ]; then
        compose config --services 2>/dev/null | grep -qx atlas-model || fail 3 'This package does not include the local CPU model. Download the complete source ZIP to use it.'
        while :; do
          if [ "$desktop" = 1 ] && [ "$dialog_method" = zenity ]; then
            exec 3> >(zenity --progress --title='Local model setup' --text='Preparing the local CPU model…' --percentage=0 --auto-close --no-cancel >/dev/null 2>&1)
            progress_dialog=1
          fi
          model_error=''
          if prepare_model; then model_ready=1; else model_ready=0; fi
          if [ "$progress_dialog" = 1 ]; then update_progress 'Model setup finished' 100; exec 3>&-; progress_dialog=0; fi
          [ "$model_ready" = 1 ] && break
          warn "$model_error"
          [ "$desktop" = 1 ] && retry_model || { hints; exit 3; }
        done
      fi ;;
    provider)
      export OPEN_HARNESS_BUNDLED_MODEL=0
      if [ "$saved_model" = local ] && [ "$action" = start ]; then
        say 'Choose your provider in Workspace settings. A running local model stops when you stop Open Harness.'
      fi ;;
  esac
elif [ -n "$model_choice" ] || [ "$desktop" = 1 ]; then
  fail 64 'The bundled CPU model launcher is available on Linux.'
fi

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

if [ "$model_images_built" = 1 ]; then
  say 'Starting the dashboard with the local CPU model…'
  compose up -d --no-build || fail 3 "Docker Compose could not start the stack."
elif [ "$build" = "1" ]; then
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

if [ "$model_choice" = local ]; then
  say 'Checking that your agents can reach the local model…'
  link_started=$SECONDS
  until compose exec -T atlas-worker-link node /opt/atlas/worker-link.mjs --health >/dev/null 2>&1; do
    [ $((SECONDS - link_started)) -lt "$timeout_seconds" ] || fail 4 'The dashboard is running, but agents cannot reach the local model. Reopen the launcher to retry the connection.'
    sleep 2
  done
fi

if [ -n "$model_choice" ] && [ "$model_choice" != "$saved_model" ]; then
  if [ -z "$preference_file" ] || ! (umask 077; mkdir -p "$(dirname "$preference_file")" &&
    printf '%s\n' "$model_choice" > "$preference_file.$$.tmp" && mv -f "$preference_file.$$.tmp" "$preference_file"); then
    warn 'This launch succeeded. Open Harness could not remember the model choice for the next launch.'
  fi
fi

# --------------------------------------------------------------- pairing ----
# The dashboard hands out its operator token only to a browser that presents a
# one-use code minted inside the coordinator container. The code travels in the
# URL fragment, omitted from the initial HTTP request. The page exchanges it
# with the local coordinator on load. It is never printed here.
urlencode() {
  value=$1; encoded=""; i=0
  while [ "$i" -lt "${#value}" ]; do
    c=${value:$i:1}
    case "$c" in
      [A-Za-z0-9_.~-]) encoded="$encoded$c" ;;
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
  say "No browser was opened (--no-open). To pair one, mint a code with: docker compose -f $compose_file exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs — then open $app_url/${setup_query}#pair=<code>."
  pause_if_wrapped; exit 0
fi

# The helper prints one JSON object with a base64url code; anything else — a
# non-zero exit, no output, or a code in another shape — means no usable link,
# and the launcher says so instead of opening a dashboard that would only ask
# for pairing. The helper's own stderr goes to the log, never to the URL.
pair_json=$(compose exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs 2>>"$log_file")
pair_status=$?
pair_code=$(printf '%s' "$pair_json" | tr -d '\n\r' | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
mint_failed() {
  fail 5 "Open Harness is running at $app_url, but no browser connection link could be created ($1). No browser was opened, because a dashboard opened without a link only asks for pairing. This usually means the coordinator image is older than this launcher or did not start correctly: run '$0 --logs', update the release if it is out of date, then run this launcher again."
}
[ "$pair_status" -eq 0 ] || mint_failed "the pairing helper in the coordinator container exited with status $pair_status"
[ -n "$pair_code" ] || mint_failed "the pairing helper printed no code"
case "$pair_code" in
  *[!A-Za-z0-9_-]*) mint_failed "the pairing helper printed a code in an unexpected form" ;;
esac
[ "${#pair_code}" -ge 32 ] && [ "${#pair_code}" -le 128 ] || mint_failed "the pairing helper printed a code of unexpected length"
target="$app_url/${setup_query}#pair=$(urlencode "$pair_code")"
if open_url "$target"; then
  say "Open Harness is running at $app_url — a paired browser window is opening."
else
  fail 5 "Open Harness is running at $app_url, but no browser could be opened from here. Run the launcher again from a desktop session, or open $app_url and follow the pairing instructions shown there."
fi
pause_if_wrapped
exit 0
