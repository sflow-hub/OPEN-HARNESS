#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1

launch() {
    binary="${CARGO_TARGET_DIR:-target}/release/open-harness"
    if [ -x "$binary" ] && "$binary" start --help | grep -q -- '--open'; then
        "$binary" start --open
        return $?
    fi

    # Finder and desktop file managers can start with a minimal PATH.
    if ! command -v cargo >/dev/null 2>&1; then
        PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
        export PATH
    fi
    if ! command -v cargo >/dev/null 2>&1; then
        echo 'Install Rust 1.89 or later to build Open Harness, then open this launcher again.' >&2
        return 1
    fi
    echo 'Building Open Harness. The dashboard will open when it is ready.'
    cargo run --locked --release --bin open-harness -- start --open
}

launch && exit 0
result=$?
if [ -t 0 ]; then
    printf '\nPress Return to close this window.'
    read -r _
fi
exit "$result"
