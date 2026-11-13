#!/bin/sh
# Keep the target's package and machine checks under both native and explicitly emulated builds.
# The emulated mode is limited to AMD64 on an ARM64 builder and must be recorded on the image.
set -eu
case "${TARGETARCH:-}" in
  arm64|amd64) ;;
  *) echo "check-native-platform: unsupported TARGETARCH '${TARGETARCH:-}' (supported: arm64, amd64)" >&2; exit 1 ;;
esac
case "${OPEN_HARNESS_BUILD_MODE:-native}" in
  native)
    if [ "${BUILDARCH:-}" != "$TARGETARCH" ]; then
      echo "check-native-platform: refusing cross or emulated build without explicit mode: BUILDARCH='${BUILDARCH:-}' TARGETARCH='$TARGETARCH'" >&2
      exit 1
    fi ;;
  emulated)
    if [ "${BUILDARCH:-}" != arm64 ] || [ "$TARGETARCH" != amd64 ]; then
      echo "check-native-platform: emulated mode requires ARM64 builder and AMD64 target" >&2
      exit 1
    fi ;;
  *) echo "check-native-platform: unsupported OPEN_HARNESS_BUILD_MODE '${OPEN_HARNESS_BUILD_MODE:-}'" >&2; exit 1 ;;
esac
dpkg_arch=$(dpkg --print-architecture)
if [ "$dpkg_arch" != "$TARGETARCH" ]; then
  echo "check-native-platform: base image architecture '$dpkg_arch' is not '$TARGETARCH'" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64|arm64) machine=arm64 ;;
  x86_64|amd64) machine=amd64 ;;
  *) machine=unknown ;;
esac
if [ "$machine" != "$TARGETARCH" ]; then
  echo "check-native-platform: kernel machine '$(uname -m)' is not '$TARGETARCH'" >&2
  exit 1
fi
echo "check-native-platform: ${OPEN_HARNESS_BUILD_MODE:-native} $TARGETARCH (builder ${BUILDARCH:-})"
