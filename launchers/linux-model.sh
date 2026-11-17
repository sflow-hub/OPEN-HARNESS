# Docker engine and Compose project together identify the workspace across extraction folders.
model_state_file() {
  local project engine
  project=$(compose config 2>/dev/null | sed -n 's/^name: \([a-z0-9][a-z0-9_-]*\)$/\1/p')
  case "$project" in ''|*[!a-z0-9_-]*) return 1 ;; esac
  engine=$(docker info --format '{{.ID}}' 2>/dev/null) || return 1
  case "$engine" in ''|*[!a-zA-Z0-9:_-]*) return 1 ;; esac
  printf '%s/open-harness/launchers/%s/%s.model' "${XDG_STATE_HOME:-$HOME/.local/state}" "$engine" "$project"
}

model_dialog() {
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then echo zenity; return; fi
    if command -v kdialog >/dev/null 2>&1; then echo kdialog; return; fi
  fi
  echo terminal
}

choose_model() {
  local saved=$1 method=$2 answer local_label own_label description
  local_label='Use a model on this computer'
  own_label='Use my own model provider'
  description='The local CPU model needs a one-time download of about 2.5 GB. It runs on this computer without an account. You can also use your existing provider in the dashboard.'
  if [ "$saved" = local ]; then description="$description Your last choice was the local model."; fi
  if [ "$saved" = provider ]; then description="$description Your last choice was your own provider."; fi
  case "$method" in
    zenity)
      answer=$(zenity --list --title='Start Open Harness' --text="$description" --column=Choice "$local_label" "$own_label" --ok-label=Continue --cancel-label=Cancel) || return 1
      case "$answer" in "$local_label") echo local ;; "$own_label") echo provider ;; *) return 1 ;; esac ;;
    kdialog)
      kdialog --title 'Start Open Harness' --menu "$description" local "$local_label" provider "$own_label" ;;
    terminal)
      printf '%s\n\n1) %s\n2) %s\n3) Cancel\nChoose 1, 2, or 3: ' "$description" "$local_label" "$own_label" >&2
      read -r answer || return 1
      case "$answer" in 1) echo local ;; 2) echo provider ;; *) return 1 ;; esac ;;
  esac
}

model_status() {
  compose exec -T atlas-model node -e '
    fetch("http://127.0.0.1:8080/health", {signal: AbortSignal.timeout(3000)})
      .then(async r => {
        const s = await r.json();
        if (r.ok !== (s.phase === "ready")) process.exit(1);
        if (!["checking", "downloading", "verifying", "loading", "ready", "error"].includes(s.phase)) process.exit(1);
        const percent = Number.isInteger(s.progress) && s.progress >= 0 && s.progress <= 100 ? s.progress : "";
        console.log([s.phase, percent, String(s.message || "").replace(/[\r\n|\x00-\x1f]/g, " ").slice(0, 320)].join("|"));
      }).catch(() => process.exit(1));' 2>/dev/null
}

update_progress() {
  if [ "$progress_dialog" = 1 ]; then
    (printf '#%s\n%s\n' "$1" "$2" >&3) 2>/dev/null || :
  fi
}

prepare_model() {
  local initial previous='' sample phase percent message began model_wait=${OPEN_HARNESS_MODEL_TIMEOUT:-7200}
  case "$model_wait" in ''|*[!0-9]*) model_error='Choose a whole number of seconds for the model setup timeout.'; return 1 ;; esac
  if [ "$build" = 1 ] && [ "$model_images_built" = 0 ]; then
    message='Building the dashboard and the local model server before loading Atlas into memory. Docker shows its progress below.'
    say "$message"; update_progress "$message" 0
    if ! compose build atlas-model open-harness; then
      model_error='Docker could not build the dashboard and local model server. Check the build output, available disk space and connection, then retry.'
      return 1
    fi
    model_images_built=1
  fi
  initial=$(model_status) || initial=''
  say 'Starting the local CPU model.'
  compose up -d --no-build atlas-model || {
    model_error='Docker could not start the local model server. Check Docker and free disk space, then retry.'; return 1;
  }
  if [[ "$initial" = error\|* ]] || [ "${model_restart_needed:-0}" = 1 ]; then
    model_restart_needed=0
    compose restart atlas-model || { model_error='Docker could not restart the local model server.'; return 1; }
  fi
  began=$SECONDS
  while [ $((SECONDS - began)) -lt "$model_wait" ]; do
    sample=$(model_status) || sample=''
    if [ -n "$sample" ]; then
      IFS='|' read -r phase percent message <<< "$sample"
      if [ -n "$percent" ]; then message="$message ($percent%)"; fi
      if [ "$sample" != "$previous" ]; then
        say "$message"; previous=$sample
        update_progress "$message" "$((${percent:-0} < 100 ? ${percent:-0} : 99))"
      fi
      case "$phase" in ready) return 0 ;; error) model_error="$message"; return 1 ;; esac
    else
      local id state restarts elapsed
      id=$(compose ps --all --quiet atlas-model 2>/dev/null)
      if [ -n "$id" ]; then
        read -r state restarts <<< "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$id" 2>/dev/null)"
        case "$state" in exited|dead) model_error='The local model server stopped. Check Docker and free disk space, then retry.'; return 1 ;; esac
        elapsed=$((SECONDS - began))
        [[ "$restarts" =~ ^[0-9]+$ ]] || restarts=0
        if [[ "$state" = restarting && ( $restarts -ge 2 || $elapsed -ge 10 ) ]] ||
          [[ "$state" = running && $restarts -ge 2 && $elapsed -ge 10 ]]; then
          model_restart_needed=1
          model_error='The local model server keeps restarting. Check Docker, available disk space and the model volume permissions, then retry.'
          return 1
        fi
      fi
    fi
    sleep 2
  done
  model_error='The local model is taking longer than expected. Check your connection and disk space, then retry to continue the download.'
  return 1
}

retry_model() {
  local answer text="$model_error

Open Harness keeps downloaded model data for the next attempt."
  case "$dialog_method" in
    zenity) zenity --question --title='Local model setup' --text="$text" --ok-label=Retry --cancel-label=Close ;;
    kdialog) kdialog --title 'Local model setup' --yes-label Retry --no-label Close --yesno "$text" ;;
    terminal)
      printf '%s\nPress Return to retry, or type q to close: ' "$text" >&2
      read -r answer && [ -z "$answer" ] ;;
  esac
}
