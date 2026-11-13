import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { initialWorkspace } from "../../lib/types";

// The runtime routes are mocked here so the screen is covered before and independently of
// the coordinator implementation; field names follow work/network-tool/CONTRACT.md.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const stamp = "2026-11-08T20:00:00.000Z";
const profile = { coordinatorUrl: null, httpProxy: null, httpsProxy: null, noProxy: null, dnsServers: [], pollIntervalMs: 2000, requestTimeoutMs: 10000, retries: 3, keepGatewayWarm: [] };
function fixture() {
  return {
    enabled: false, updatedAt: null,
    machines: [
      { id: "local", name: "Studio Mac", local: true, status: "online", lastSeenAt: stamp, agents: [{ id: "ava", name: "Ava", route: "socket" }], profile },
      { id: "m-build", name: "Build box", local: false, status: "online", lastSeenAt: stamp, agents: [{ id: "rex", name: "Rex", route: "url" }], profile: { ...profile, coordinatorUrl: "http://10.0.0.4:4317" } },
    ],
    links: [
      { id: "l-gw", kind: "gateway", from: "ava", to: "local", label: "Ava’s Hermes gateway", machineId: "local", state: "degraded", latencyMs: 4200, testedAt: stamp, detail: "Gateway started cold for this turn." },
      { id: "l-run", kind: "coordinator-runner", from: "m-build", to: "coordinator", label: "Build box → coordinator", machineId: "m-build", state: "failing", latencyMs: null, testedAt: stamp, detail: "Connection timed out after 5 s." },
    ],
    pending: [{ id: "c-1", machineId: "m-build", setting: "coordinatorUrl", before: "http://10.0.0.4:4317", after: "https://coordinator.tailnet.ts.net", reason: "The LAN address stopped answering; the tailnet name answers in 38 ms.", evidenceProbeIds: ["p-1"], proposedBy: { type: "agent", agentId: "rex", agentName: "Rex", runId: "run-1" }, state: "awaiting_approval", confirmation: "a".repeat(64), createdAt: stamp, updatedAt: stamp }],
    history: [{ id: "c-0", machineId: "local", setting: "keepGatewayWarm", before: [], after: ["ava"], reason: "Cold starts dominate chat latency.", evidenceProbeIds: [], proposedBy: { type: "agent", agentId: "ava", agentName: "Ava", runId: "run-0" }, state: "applied", confirmation: "b".repeat(64), verification: { probeId: "p-0", state: "ok", detail: "Next turn started in 300 ms." }, createdAt: stamp, updatedAt: stamp }],
    probes: [{ id: "p-1", linkId: "l-run", kind: "coordinator-runner", state: "failing", latencyMs: null, detail: "Connection timed out after 5 s.", startedBy: { type: "agent", agentId: "rex", runId: "run-1" }, createdAt: stamp }],
  };
}
async function openSettings(page: Page, testInfo: TestInfo, request: import("@playwright/test").APIRequestContext) {
  const { token } = await (await request.get(`${control}/v1/bootstrap`)).json();
  await request.post(`${control}/v1/agents/sync`, { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
  await page.addInitScript(() => localStorage.setItem("open-harness.onboarding.v1", "done"));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /Settings/ }).first().click();
  return page.getByRole("region", { name: "Network tools" });
}

test("network tools start off, turn on from settings and show every computer's connections", async ({ page, request }, testInfo) => {
  const state = fixture(), writes: unknown[] = [];
  await page.route("**/v1/network", route => route.fulfill({ json: state }));
  await page.route("**/v1/network/settings", route => { const input = route.request().postDataJSON(); writes.push(input); state.enabled = input.enabled; return route.fulfill({ json: { enabled: state.enabled, updatedAt: stamp } }); });
  const panel = await openSettings(page, testInfo, request);
  const toggle = panel.getByRole("checkbox", { name: /Let agents test and change network connections/ });
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByText(/Agents can’t run network tests/)).toBeVisible();
  await expect(panel.getByText(/never change firewall rules/)).toBeVisible();
  const connections = panel.getByRole("region", { name: "Connections" });
  await expect(connections.getByText("Studio Mac")).toBeVisible();
  await expect(connections.getByText("Build box → coordinator")).toBeVisible();
  await expect(connections.getByText(/Not connecting/)).toBeVisible();
  await expect(connections.getByText("Connection timed out after 5 s.")).toBeVisible();
  await expect(connections.getByText(/Slow · 4200 ms/)).toBeVisible();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(panel.getByRole("status")).toContainText("Network tools are on");
  await expect(panel.getByText(/Each agent also needs Network turned on/)).toBeVisible();
  expect(writes).toEqual([{ enabled: true }]);
  const box = await panel.boundingBox(), viewport = page.viewportSize()!;
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
});

test("a proposed change shows before and after with its evidence and is approved with its exact digest", async ({ page, request }, testInfo) => {
  const state = fixture(); let decision: unknown = null;
  state.enabled = true;
  await page.route("**/v1/network", route => route.fulfill({ json: state }));
  await page.route("**/v1/network/changes/c-1/decision", route => { decision = route.request().postDataJSON(); const change = { ...state.pending[0], state: "verifying" }; state.pending = []; state.history = [change, ...state.history] as typeof state.history; return route.fulfill({ json: change }); });
  const panel = await openSettings(page, testInfo, request);
  const card = panel.getByRole("article", { name: "Coordinator address on Build box" });
  await expect(card.getByText(/Rex suggests changing/)).toBeVisible();
  await expect(card.getByText("http://10.0.0.4:4317")).toBeVisible();
  await expect(card.getByText("https://coordinator.tailnet.ts.net")).toBeVisible();
  await expect(card.getByRole("list", { name: "Test results behind this suggestion" })).toContainText("Build box → coordinator: Not connecting");
  await card.getByRole("button", { name: "Approve change" }).click();
  await expect(panel.getByRole("status")).toContainText("Approved");
  expect(decision).toEqual({ approved: true, confirmation: "a".repeat(64) });
  await expect(panel.getByRole("region", { name: "Changes waiting for approval" })).toHaveCount(0);
  await panel.getByText(/Change history \(2\)/).click();
  await expect(panel.getByText("Checking the new setting…", { exact: false })).toBeVisible();
});

test("tests, denials and reverts report plain results and keep the screen usable after a failure", async ({ page, request }, testInfo) => {
  const state = fixture(); let reverts = 0, failDecision = true;
  state.enabled = true;
  await page.route("**/v1/network", route => route.fulfill({ json: state }));
  await page.route("**/v1/network/tests", route => route.fulfill({ json: { probes: [{ ...state.probes[0], id: "p-2" }, { ...state.probes[0], id: "p-3", linkId: "l-gw", state: "ok", latencyMs: 120 }] } }));
  await page.route("**/v1/network/changes/c-1/decision", route => failDecision ? route.fulfill({ status: 409, json: { error: "This change was updated. Review it again before deciding." } }) : route.fulfill({ json: { ...state.pending[0], state: "denied" } }));
  await page.route("**/v1/network/settings", route => route.fulfill({ status: 503, json: { error: "The coordinator is restarting. Try again in a moment." } }));
  await page.route("**/v1/network/changes/c-0/revert", route => { reverts++; return route.fulfill({ json: { ...state.history[0], id: "c-2", revertOf: "c-0", state: "verifying" } }); });
  const panel = await openSettings(page, testInfo, request);
  const toggle = panel.getByRole("checkbox", { name: /Let agents test and change network connections/ });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(panel.getByRole("alert")).toHaveText("The coordinator is restarting. Try again in a moment.");
  await expect(toggle).toBeChecked();
  await panel.getByRole("button", { name: "Run connection tests" }).click();
  await expect(panel.getByRole("status")).toHaveText("1 of 2 connections need attention.");
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByRole("alert")).toHaveText("This change was updated. Review it again before deciding.");
  await expect(panel.getByRole("button", { name: "Approve change" })).toBeEnabled();
  failDecision = false;
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByRole("status")).toHaveText("Denied. Nothing changed.");
  await panel.getByText(/Change history/).click();
  await expect(panel.getByText(/Keep agent ready between messages/)).toBeVisible();
  await panel.getByRole("button", { name: "Revert" }).click();
  await expect(panel.getByRole("status")).toContainText("Reverting");
  expect(reverts).toBe(1);
});

test("an older coordinator without network tools shows a quiet note instead of an error", async ({ page, request }, testInfo) => {
  await page.route("**/v1/network", route => route.fulfill({ status: 404, json: { error: "Not found" } }));
  const panel = await openSettings(page, testInfo, request);
  await expect(panel.getByText(/aren’t available from this coordinator yet/)).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("checkbox")).toBeDisabled();
});
