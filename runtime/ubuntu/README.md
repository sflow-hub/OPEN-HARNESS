# Ubuntu runtime build inputs

`runtime/hermes/Dockerfile` uses these helpers and locks for Linux ARM64 and AMD64
builds. Native builds are the default. An ARM64 BuildKit builder may target AMD64
only with `OPEN_HARNESS_BUILD_MODE=emulated`; the image records that mode and the
guard still checks the target architecture. Build the default final target: it
depends on package, ELF/linkage and Debian-origin verification.

The source uses Ubuntu 26.04, the official Python 3.12.14 prefix and Node 24.21.0,
authenticated Debian Chromium packages, and the distribution curl source rebuilt
with HTTP/3. Signed APT verification, exact input hashes, both curl TLS flavours
and the distribution test policy remain enabled. No Debian repository is added
to the Ubuntu image.

The lock records the reviewed input selection and evidence-bound architecture
corrections. Its `validation` field describes what each architecture has actually
verified; detailed execution evidence belongs in `runtime/VERIFICATION.md`.
Ubuntu APT uses the fixed, signed `20260929T180000Z` snapshot after a pinned
`ca-certificates` bootstrap from the signed live archive. The helper verifies
that every package index comes from that snapshot and restores any bootstrap
package changes to their locked versions. If an exact input disappears or the
snapshot cannot be verified, the build fails rather than accepting another
version. Debian browser inputs remain independently pinned and verified.
AMD64's Ubuntu package set still needs a completed, verified AMD64 image build.

The portable ARM64 candidate built on September 29, 2026 and verified all 329
packages and 90 native files. The curl distribution's `test-nonflaky` policy
ignored test 1510 in both flavours, with 149 OpenSSL and 152 GnuTLS tests skipped.
That build is not proof of final contract-7 image security or functional acceptance.
Whole-image and supplemental Debian-origin scans, actual tools and desktop checks,
platform acceptance and the final soak remain release requirements.

## Supplemental Debian-origin release gate

A whole-image scan reads the image's dpkg database as Ubuntu, so it does not
look up Debian advisories for `chromium`, `chromium-common` and
`libjpeg62-turbo`. `scripts/debian-origin-gate.py` adds that coverage for one
immutable local Hermes image on its native architecture and keeps the
whole-image scan:

```sh
python3 -I -B scripts/debian-origin-gate.py --image sha256:<image ID> --arch arm64 \
  --trivy /absolute/path/to/trivy --cache-dir /absolute/trivy/cache --out <new directory>
```

It needs Docker, a Trivy binary and a Trivy cache whose `db/` was downloaded
beforehand; it downloads nothing. Two probe containers of the image rebuild the
Debian component from the retained archives and bind it to the image's
build-time inventory. They are read-only, network-less, non-root and
capability-free, and mount only the helper and lock directories (read-only) and
one output directory. The eleven scan and check steps then run with unchanged
thresholds, a private copy of the database and no inherited scanner
configuration. `receipt.json` is written only when every step and binding
passed; otherwise `failure.json` names the failure. Either way, `status.json`,
`calls/`, `steps/` and `reports/` keep the raw commands, exit codes and reports.

The release workflow still needs the reviewed gate integration. Its source
change has not been accepted. `publish-architecture` in
`scripts/release-images.mjs` refuses to publish unless
the receipt is complete and for the exact scanned image, sources and database.
`verify-debian-origin-gate <directory> <arch> <image>` runs the same check
read-only. Offline tests with fake Docker and Trivy CLIs:
`tests/ubuntu-runtime/test_release_gate.py` and
`tests/debian-origin-gate.test.ts`.

Run offline helper tests with Python 3.12:

```sh
python3 -B -m unittest discover -s tests/ubuntu-runtime -v
```

Synthetic helper and Dockerfile checks run in Linux CI. Additional recorded-evidence
checks run when `OH_EVIDENCE_BASE` points to the preserved verification packets;
they explicitly skip when those private local artifacts are absent.
