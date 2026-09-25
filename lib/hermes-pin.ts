// The pinned Hermes build, in one place. The Dockerfile cannot import this, so
// tests/runtime-contract.test.ts asserts the two agree rather than trusting them to.
export const HERMES_RELEASE = 'v2026.9.11';
export const HERMES_COMMIT = '939e45c91d751fadd94dcd1b873ac3cb44846213';
export const HERMES_IMAGE_TAG = HERMES_RELEASE.replace(/^v/, '');
