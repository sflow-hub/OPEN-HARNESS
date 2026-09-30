# Runtime dependency packaging

These dependency updates are integrated into unreleased source under runtime
contract 7. They are not a released or scan-approved image. Hermes stays pinned to
`939e45c91d751fadd94dcd1b873ac3cb44846213`.
No reasoning-loop source is modified.

The original contract-5 ARM64 image reported 363 HIGH and 23 CRITICAL vulnerability
occurrences with Trivy 0.74.0 on September 26, 2026. The release gate remains unchanged;
no findings are ignored. The final contract-5 packaging candidate passes real
protocol, desktop, selected-folder and native-library checks, but still reports
94 HIGH and 1 CRITICAL occurrences (36 distinct IDs). Publication remains blocked;
contract-6 image evidence is recorded separately in `runtime/VERIFICATION.md`.

- Base: digest-pinned Ubuntu 26.04, with the official Python 3.12.14 prefix and
  authenticated Debian Chromium archives. `runtime/ubuntu/lock` pins the exact
  package sets and input hashes. The final build target checks package identity,
  native architecture, linkage and Debian file provenance. The Ubuntu whole-image
  scan and a separate scan of the bound Debian components are both mandatory;
  the Ubuntu identity is never relabeled as Debian. See `runtime/ubuntu/README.md`
  and `runtime/VERIFICATION.md` for the candidate's evidence and remaining checks.
- curl: the signed Ubuntu source retains distribution patches and both TLS
  flavours. The offline, non-root rebuild enables HTTP/3 and captures complete
  build/test logs. It preserves the vendor `test-nonflaky` policy, including its
  ignored flaky failures; build success alone is not complete protocol coverage.
- Node: official Node 24.21.0 Linux distribution, copied from its digest-pinned
  Trixie image. The Debian Node/npm bootstrap and NodeSource installer are omitted.
  This avoids keeping the replaced distribution's older JavaScript dependencies
  and does not introduce a second distro Python through NodeSource.
- npm: 11.20.0 replaces 11.19.0. Its verified official archive bundles
  `brace-expansion` 5.0.9, `ip-address` 10.5.0 and `tar` 7.5.22, which meet the fixes
  listed by the baseline scan. Whole-package installation preserves npm consistency.
- Python: `httpx2` 2.7.0 and its matching `httpcore2` 2.7.0 become 2.12.0.
  `httpx2` 2.12.0 requires `httpcore2==2.12.0`; MCP 2.0.0 permits `httpx2>=2.5.0`.
  CVE-2026-84381 is fixed in 2.10.0; CVE-2026-84382 requires httpx2 2.12.0.
  The patch checks the original manifest SHA256 and replaces only its three
  `httpx2==2.7.0` declarations (dev, MCP, computer-use extras). A separate original
  SHA256 check covers the one matching requirement in `tools/lazy_deps.py`;
  otherwise real computer-use startup attempts to restore the vulnerable pin.
  Both files are verified before either is written. No control flow changes.
  Constraints enforce the matching pair during installation, and `pip check`
  plus real protocol and desktop fixtures must pass.
- Provider construction needs exact lazy-dependency pins before the agent runs.
  The Dockerfile includes the upstream `bedrock` and `anthropic` extras alongside
  `all`, then checks both plus Vertex with Hermes's own `feature_missing` function. Bedrock's
  adapter is imported even for local OpenAI-compatible endpoints; Anthropic's
  SDK is required when constructing its native client. The model picker's startup
  scan also imports Vertex; `[all]` already supplies its exact Google SDK pins,
  and the build check makes that requirement explicit. Constraints pin the six
  packages added by the reviewed SDK candidates. These are packaging changes;
  the pinned upstream provider dispatch and lazy-install policy remain intact.
- Compiler/header packages are transient build dependencies for the browser native
  addon installation and are purged in the same layer. The MVP runtime retains
  Python, Node, shell, git, curl and ripgrep; it does not promise an installed C/C++
  development environment or an unchanged inventory of OS utilities. Browser
  installer outputs stay intact. Chromium, agent-browser 0.37.1, Camofox 1.16.0,
  Xvfb, Openbox, DBus and CUA driver 0.28.2 remain installed.
- Native-library inspection found that the slim Python base ships `_tkinter`
  without its Tcl/Tk shared libraries. `libtk8.6` is explicitly retained for that
  shipped extension. The npm browser package also ships a separate musl prebuild;
  the glibc runtime selects its glibc addon, which must pass a real SQLite check.
- Trixie creates `/home/hermes` with mode `0700`; production containers run as the
  coordinator's UID and cannot traverse that image-owned parent. Its mode is
  explicitly `0755`, as in the original Bookworm image. Per-agent profile and
  private mounts retain their separate restricted permissions. Real protocol and
  desktop fixtures must exercise the mounted profile as the coordinator UID.

References: [Debian GLib tracker](https://security-tracker.debian.org/tracker/source-package/glib2.0),
[Debian libxml2 tracker](https://security-tracker.debian.org/tracker/source-package/libxml2),
[pinned Hermes manifest](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/pyproject.toml),
[httpx2 2.12.0 metadata](https://pypi.org/pypi/httpx2/2.12.0/json),
[MCP 2.0.0 metadata](https://pypi.org/pypi/mcp/2.0.0/json),
[npm 11.20.0 metadata](https://registry.npmjs.org/npm/11.20.0).
