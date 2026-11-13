#!/bin/sh
# Pin every later Ubuntu APT step of this stage to one fixed, signed Ubuntu snapshot. Run it after the platform
# guard and before any other apt-get. Usage: ubuntu-snapshot.sh SNAPSHOT OS_PACKAGE_LIST
#
# The fixed snapshot is fetched over HTTPS, and the base image has no CA certificates. Bootstrap ca-certificates from
# the signed live archive; older versions may have rotated out. This also installs or upgrades OpenSSL packages.
# After the switch, every package that bootstrap installed or changed is reinstalled from the snapshot: base-image
# packages at their base version, new packages at their OS-list pin. The dpkg state must then be exactly the base
# state plus those pins. Signature checks are unchanged (the base image's Ubuntu archive keyring verifies the live
# and snapshot InRelease files), every update fails on any fetch error, and every package index must be the snapshot.
set -eu
snapshot=${1:-}
pins=${2:-}
conf=${OH_APT_ETC:-/etc/apt}/apt.conf.d/99-open-harness-snapshot
sources=${OH_APT_ETC:-/etc/apt}/sources.list.d/ubuntu.sources
fail() { echo "ubuntu-snapshot: $*" >&2; exit 1; }
installed() {
  dpkg-query -W -f='${db:Status-Abbrev} ${Package} ${Version}\n' | awk '$1 == "ii" { print $2, $3 }' | LC_ALL=C sort
}

case "$snapshot" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) fail "snapshot '$snapshot' is not YYYYMMDDTHHMMSSZ" ;;
esac
[ -f "$pins" ] || fail "no OS package list '$pins'"
[ "$(grep -c '^ca-certificates=' "$pins")" = 1 ] || fail "$pins must pin ca-certificates exactly once"
[ ! -e "$conf" ] || fail "$conf already exists"
[ -f "$sources" ] || fail "no Ubuntu sources '$sources'"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Origin-based snapshot selection can also fetch live indexes after a layer clears APT's cached metadata.
awk -v uri="https://snapshot.ubuntu.com/ubuntu/$snapshot/" '
  $1 == "URIs:" {
    if (NF != 2 || $2 !~ /^https?:\/\/(ports\.ubuntu\.com\/ubuntu-ports|archive\.ubuntu\.com\/ubuntu|security\.ubuntu\.com\/ubuntu)\/?$/) { bad = 1; next }
    print "URIs: " uri; count++; next
  }
  { print }
  END { if (!count) bad = 1; exit bad }' "$sources" > "$work/sources" || fail "unsupported Ubuntu source URI"

installed > "$work/base"
[ -s "$work/base" ] || fail "dpkg-query listed no installed packages"
apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates
installed > "$work/bootstrap"

printf 'APT::Update::Error-Mode "any";\n' > "$conf"
cat "$work/sources" > "$sources"
apt-get -o Acquire::Retries=0 update
apt-cache policy > "$work/policy"
awk -v want="^https://snapshot[.]ubuntu[.]com/[a-z-]+/$snapshot\$" '
  $1 ~ /^[0-9]+$/ && $2 ~ /:\/\// { files++; if ($2 !~ want) { print "ubuntu-snapshot: package index not from the snapshot: " $0 > "/dev/stderr"; bad = 1 } }
  END { if (!files) { print "ubuntu-snapshot: APT has no package indexes" > "/dev/stderr"; bad = 1 } exit bad }' "$work/policy" \
  || fail "APT is not limited to snapshot $snapshot"

# Target state: the base packages at their base versions plus the bootstrap's new packages at their pins.
awk -v pins="$pins" -v expected="$work/expected" '
  BEGIN { while ((getline line < pins) > 0) { i = index(line, "="); pin[substr(line, 1, i - 1)] = substr(line, i + 1) } }
  FNR == NR { base[$1] = $2; next }
  { now[$1] = $2 }
  END {
    for (p in base) if (!(p in now)) { print "ubuntu-snapshot: the CA bootstrap removed " p > "/dev/stderr"; bad = 1 }
    for (p in now) {
      if (p in base) want = base[p]
      else if (p in pin) want = pin[p]
      else { print "ubuntu-snapshot: the CA bootstrap installed " p ", which the OS package list does not pin" > "/dev/stderr"; bad = 1; continue }
      print p, want > expected
      if (now[p] != want) print p "=" want
    }
    exit bad
  }' "$work/base" "$work/bootstrap" > "$work/changed" || fail "the CA bootstrap changed packages it may not"
LC_ALL=C sort "$work/changed" > "$work/repair"
if [ -s "$work/repair" ]; then
  echo "ubuntu-snapshot: reinstalling from snapshot $snapshot:" $(cat "$work/repair")
  DEBIAN_FRONTEND=noninteractive xargs apt-get install -y --no-install-recommends --allow-downgrades < "$work/repair"
fi
installed > "$work/final"
LC_ALL=C sort "$work/expected" | cmp -s - "$work/final" || {
  LC_ALL=C sort "$work/expected" | diff - "$work/final" >&2 || true
  fail "the dpkg state is not the base state plus the pins after the repair"
}
echo "ubuntu-snapshot: snapshot $snapshot; $(awk 'END { print NR }' "$work/repair") package(s) reinstalled from it"
