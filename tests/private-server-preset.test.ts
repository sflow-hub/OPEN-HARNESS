import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "harness-private-server-")), deploy = join(directory, "deploy/private-server"), bin = join(directory, "bin"), log = join(directory, "commands.log");
  mkdirSync(deploy, { recursive: true }); mkdirSync(bin);
  copyFileSync(new URL("../deploy/private-server/start.sh", import.meta.url), join(deploy, "start.sh"));
  writeFileSync(join(directory, "compose.yaml"), "services: {}\n");
  writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HARNESS_PRESET_LOG"\nif [ "$*" = "compose version --short" ]; then printf "%s\\n" "${HARNESS_COMPOSE_VERSION:-2.24.4}"; fi\n');
  writeFileSync(join(bin, "tailscale"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HARNESS_PRESET_LOG"\nif [ "$*" = "status --json" ]; then printf \'{\\n  "Self": {\\n    "DNSName": "server.tailnet.ts.net."\\n  }\\n}\\n\'; fi\nif [ "$*" = "serve status --json" ]; then printf "%s\\n" "${HARNESS_SERVE_STATUS:-{}}"; fi\n');
  chmodSync(join(bin, "docker"), 0o700); chmodSync(join(bin, "tailscale"), 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (domain = "server.tailnet.ts.net", extra: Record<string, string> = {}) => spawnSync("bash", [join(deploy, "start.sh"), domain], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ""}`, HARNESS_PRESET_LOG: log, ...extra } });
  return { directory, log, run };
}

test("private server setup validates the identity and keeps credentials out of its environment file", t => {
  const { directory, log, run } = fixture(t), result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, ".env.private-server"), "utf8"), "OPEN_HARNESS_REMOTE_ORIGIN=https://server.tailnet.ts.net\n");
  if (process.platform !== "win32") assert.equal(statSync(join(directory, ".env.private-server")).mode & 0o777, 0o600);
  const calls = readFileSync(log, "utf8"); assert.match(calls, /config --quiet/); assert.match(calls, /up -d --build --wait --wait-timeout 1800/); assert.match(calls, /serve --bg --https=443 http:\/\/127\.0\.0\.1:3000/); assert.match(calls, /browser-pair\.mjs/); assert.doesNotMatch(calls, /funnel|down -v|0\.0\.0\.0/);
});

test("private server setup refuses unsafe hosts, old Compose, existing proxy configuration, and existing settings", t => {
  const { directory, log, run } = fixture(t);
  for (const domain of ["https://server.tailnet.ts.net", "server.example.com", "server.tailnet.ts.net;touch bad", "other.tailnet.ts.net"]) assert.notEqual(run(domain).status, 0);
  assert.notEqual(run(undefined, { HARNESS_COMPOSE_VERSION: "2.24.3" }).status, 0);
  assert.notEqual(run(undefined, { HARNESS_SERVE_STATUS: '{"TCP":{"443":{}}}' }).status, 0);
  assert.ok(!existsSync(join(directory, ".env.private-server")));
  writeFileSync(join(directory, ".env.private-server"), "EXISTING=preserved\n");
  assert.notEqual(run().status, 0); assert.equal(readFileSync(join(directory, ".env.private-server"), "utf8"), "EXISTING=preserved\n");
  assert.doesNotMatch(readFileSync(log, "utf8"), /up -d|serve --bg/);
});

test("private server overlay replaces host ports and preserves pairing and private engine topology", () => {
  const overlay = readFileSync(new URL("../deploy/private-server/compose.yaml", import.meta.url), "utf8"), base = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.match(overlay, /ports: !override\s+- "127\.0\.0\.1:3000:3000"/);
  assert.match(overlay, /OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: "1"/);
  assert.match(overlay, /OPEN_HARNESS_REMOTE_ORIGIN:\?Set the private HTTPS origin/);
  assert.doesNotMatch(overlay, /privileged|docker\.sock|networks:|0\.0\.0\.0/);
  assert.match(base, /networks: \[runtime\]/);
  assert.match(base, /restart: unless-stopped/);
});
