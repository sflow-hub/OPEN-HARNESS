// The coordinator imports node:sqlite (runtime/db.ts), which does not exist before
// Node 22. Without this guard a wrong Node version surfaces as ~29 unrelated test
// failures reporting ERR_UNKNOWN_BUILTIN_MODULE, which says nothing about the cause.
// Kept dependency-free and free of tsx so it still runs when the toolchain is broken.
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 13;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR)) {
  console.error(`Open Harness needs Node ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer, but this is Node ${process.versions.node}.`);
  console.error('The control service imports node:sqlite, which earlier releases do not provide.');
  console.error('This checkout pins the version in .nvmrc — run "nvm use" (or "nvm install") and try again.');
  process.exit(1);
}
