import type { Page, Route } from '@playwright/test';
import type { SetupJob } from '../../lib/product';

export async function setupFixture(page: Page, options: { status?: () => Record<string, unknown>; prepare?: (kind: string) => Promise<void> | void; detail?: string } = {}) {
  let verified = false;
  const jobs: SetupJob[] = [];
  await page.route('**/v1/readiness', async route => {
    const response = await route.fetch(), status = options.status ? options.status() : await response.json();
    await route.fulfill({ response, json: { ...status, setupJobs: jobs, taskVerified: verified } });
  });
  async function run(route: Route, job: SetupJob) {
    const accepted = { ...job };
    void Promise.resolve().then(async () => {
      if (job.kind === 'verify-task') {
        verified = true;
        job.detail = 'Fixture independent file readback passed.';
      } else {
        await options.prepare?.(job.kind);
        job.detail = options.detail || 'This setup step completed.';
      }
      job.state = 'completed';
    }).catch(error => { job.state = 'failed'; job.detail = error.message; });
    await route.fulfill({ status: 202, headers: { 'Access-Control-Allow-Origin': route.request().headers().origin || '*', 'Access-Control-Allow-Credentials': 'true' }, json: accepted });
  }
  await page.route('**/v1/setup/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const stamp = new Date().toISOString();
    const job: SetupJob = { id: crypto.randomUUID(), kind: route.request().postDataJSON().kind, state: 'queued', detail: 'Fixture setup progress saved.', runId: null, createdAt: stamp, updatedAt: stamp };
    jobs.unshift(job);
    await run(route, job);
  });
  await page.route('**/v1/setup/jobs/*/resume', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const job = jobs.find(item => item.id === id);
    if (!job || route.request().method() !== 'POST') return route.fallback();
    job.state = 'queued';
    job.updatedAt = new Date().toISOString();
    await run(route, job);
  });
}
