import { test, expect, type APIRequestContext } from "@playwright/test";
import { initialWorkspace } from "../../lib/types";
import type { Workflow } from "../../lib/workflows";

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function completedRun(request: APIRequestContext, prompt: string) {
  const { token } = await (await request.get(`${control}/v1/bootstrap`)).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(`${control}/v1/agents/sync`, { headers, data: { agents: initialWorkspace.agents } });
  const response = await request.post(`${control}/v1/runs`, { headers, data: { agentId: "atlas", prompt } });
  expect(response.ok()).toBeTruthy(); const run = await response.json();
  await expect.poll(async () => (await (await request.get(`${control}/v1/runs/${run.id}`, { headers })).json()).state).toBe("completed");
  return { run, headers };
}

test("reviewed conversation becomes a tested calendar routine and a managed skill", async ({ page, request }, testInfo) => {
  const name = `Weekly report ${testInfo.project.name} ${Date.now()}`;
  const { run, headers } = await completedRun(request, name);
  await page.addInitScript(() => { localStorage.setItem("open-harness.onboarding.v1", "done"); localStorage.setItem("open-harness.advanced.v1", "on"); });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Reusable workflows" });
  await panel.getByLabel("Completed conversation").selectOption(run.id);
  await panel.getByRole("button", { name: "Create workflow draft" }).click();
  await expect(panel.getByRole("button", { name: "Run workflow test" })).toBeDisabled();
  await panel.getByLabel("Workflow instructions").fill("Prepare the weekly report and check each source date.");
  await panel.getByLabel("Success criteria").fill("The report contains current source dates and verified citations.");
  await panel.getByRole("button", { name: "Save revision" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved a new revision");
  await panel.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(panel.getByRole("button", { name: "Save routine" })).toBeDisabled();
  await panel.getByRole("button", { name: "Run workflow test" }).click();
  await expect(panel.getByText("Latest test: completed · pending")).toBeVisible({ timeout: 20000 });
  await panel.getByLabel("Test evidence").fill("Checked the generated report and every cited source date in this scripted fixture.");
  await panel.getByRole("button", { name: "Accept test result" }).click();
  await panel.getByRole("button", { name: "Publish as skill" }).click();
  await expect(panel.getByRole("status")).toContainText("Published to the agent");
  await panel.getByLabel("Time zone", { exact: true }).fill("America/Denver");
  await panel.getByLabel("Time", { exact: true }).fill("08:30");
  await panel.getByRole("button", { name: "Save routine" }).click();
  await expect(panel.getByRole("status")).toContainText("Routine saved");
  const workflows = (await (await request.get(`${control}/v1/workflows`, { headers })).json()).workflows as Workflow[];
  const saved = workflows.find(workflow => workflow.sourceRunId === run.id)!;
  expect(saved.revision).toBe(2); expect(saved.reviewedRevision).toBe(2); expect(saved.publishedRevision).toBe(2);
  expect(saved.routine?.schedule).toEqual({ kind: "calendar", weekdays: [1, 2, 3, 4, 5], timezone: "America/Denver", time: "08:30" });
  expect(saved.tests[0].verdict).toBe("passed"); expect(saved.routine?.enabled).toBe(true);
  await panel.getByRole("button", { name: "Pause routine" }).click();
  await expect(panel.getByRole("button", { name: "Resume routine" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("conflicting workflow saves preserve the local draft and name the saved revision", async ({ page, request }, testInfo) => {
  const name = `Workflow conflict ${testInfo.project.name} ${Date.now()}`, { run, headers } = await completedRun(request, name);
  const workflow = await (await request.post(`${control}/v1/workflows`, { headers, data: { sourceRunId: run.id } })).json() as Workflow;
  await page.addInitScript(() => { localStorage.setItem("open-harness.onboarding.v1", "done"); localStorage.setItem("open-harness.advanced.v1", "on"); });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Reusable workflows" });
  await panel.getByRole("navigation", { name: "Saved workflows" }).getByRole("button", { name: new RegExp(name) }).click();
  await panel.getByLabel("Workflow instructions").fill("My unsaved correction must survive.");
  await request.patch(`${control}/v1/workflows/${workflow.id}`, { headers, data: { revision: 1, name, instructions: "Changed in another tab.", successCriteria: workflow.successCriteria } });
  await panel.getByRole("button", { name: "Save revision" }).click();
  await expect(panel.getByRole("alert")).toContainText("revision 2");
  await expect(panel.getByLabel("Workflow instructions")).toHaveValue("My unsaved correction must survive.");
});
