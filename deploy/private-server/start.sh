#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 1 || ! "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z0-9]([a-z0-9-]*[a-z0-9])?\.ts\.net$ ]]; then
  echo 'Usage: bash deploy/private-server/start.sh server.tailnet.ts.net' >&2
  exit 2
fi
domain="$1"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo"
command -v docker >/dev/null || { echo 'Install Docker and Docker Compose first.' >&2; exit 1; }
command -v tailscale >/dev/null || { echo 'Install Tailscale and sign this server into your private network first.' >&2; exit 1; }
version="$(docker compose version --short)"
version="${version#v}"
IFS=. read -r major minor patch <<< "$version"
patch="${patch%%-*}"
if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]] || (( major < 2 || (major == 2 && (minor < 24 || (minor == 24 && patch < 4))) )); then
  echo 'Docker Compose 2.24.4 or later is required to keep the dashboard bound only to loopback.' >&2
  exit 1
fi
tailscale status >/dev/null
actual="$(tailscale status --json | awk -F '"' '/"Self":/ { self=1 } self && /"DNSName":/ { print $4; exit }')"
actual="${actual%.}"
if [[ "$actual" != "$domain" ]]; then
  echo 'Use this server’s own Tailscale DNS name from tailscale status --json (Self.DNSName).' >&2
  exit 1
fi
serve="$(tailscale serve status --json)"
serve="$(printf '%s' "$serve" | tr -d '[:space:]')"
if [[ "$serve" != '{}' && "$serve" != 'null' && -n "$serve" ]]; then
  echo 'This server already has a Tailscale Serve configuration. Follow README.md to add Open Harness without replacing it.' >&2
  exit 1
fi
if [[ -e .env.private-server || -L .env.private-server ]]; then
  echo 'The private-server settings already exist. Use the lifecycle commands in deploy/private-server/README.md.' >&2
  exit 1
fi
# This contains only the validated origin; model and operator credentials stay managed.
(set -o noclobber; printf 'OPEN_HARNESS_REMOTE_ORIGIN=https://%s\n' "$domain" > .env.private-server)
compose=(docker compose --env-file .env.private-server -f compose.yaml -f deploy/private-server/compose.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --wait --wait-timeout 1800
# Serve is private to the tailnet. Funnel must never be enabled for this preset.
tailscale serve --bg --https=443 http://127.0.0.1:3000
"${compose[@]}" exec -T open-harness node --input-type=module -e 'import { execFileSync } from "node:child_process"; const pair=JSON.parse(execFileSync(process.execPath,["/opt/open-harness/runtime/browser-pair.mjs"],{encoding:"utf8"})); const origin=new URL(process.env.OPEN_HARNESS_PUBLIC_URL).origin; console.log(`Open on your own connected device within five minutes:\n${origin}/#pair=${pair.code}`);'
