# Complete-experience acceptance

The implementation is a candidate. A release needs **180 live trials**, nine workflows × ten trials × two editions. `lib/reference-workflows.ts` supplies parameterized goals and outcome checklists; the same examples are available in the assistant. Contract fixtures and browser tests never count toward this matrix.

Use dedicated test accounts, repositories, mailboxes, calendars, Drive folders and spreadsheets. Configure agent tool grants and connection sharing explicitly. Keep email sending disabled for draft workflows. Prepare supervised code changes in the sandbox and retain real test output before approving a draft PR. Record host hardware/OS, model/provider, image digest, workspace edition, network latency/bandwidth, cold/warm state and operator intervention.

`npm run acceptance -- run --live --config CASES.json --out artifacts/acceptance/trials.json` starts the configured trials sequentially and resumes with the same campaign ID after interruption. It refuses a test runtime. Tokens come from named environment variables and are never written to evidence. It never approves an action or invents a quality verdict: review approvals in the workspace and save the task’s outcome review. It performs a separate read-only destination check and retains a content digest. Configure an explicit readback for each trial; use unique resources/periods across campaign configurations. Sensitive source contents remain in the dedicated accounts.

Example configuration structure (supply all nine cases for each edition):

```json
{
  "campaignId": "private-alpha-01",
  "cases": [{
    "edition": "self-hosted",
    "workflowId": "sales-leads",
    "origin": "http://localhost:4317",
    "tokenEnv": "OPEN_HARNESS_ACCEPTANCE_LOCAL_TOKEN",
    "agentId": "atlas",
    "host": "reference-host hardware and OS",
    "model": "approved model ID",
    "parameters": {"leadCriteria": "dedicated trial criteria", "spreadsheetId": "TEST_SHEET_ID", "range": "Trial01!A1:F10"},
    "readback": {"connectionId": "TEST_CONNECTION_ID", "operation": "sheets.read", "input": {"spreadsheetId": "TEST_SHEET_ID", "range": "Trial01!A1:F10"}, "contains": ["expected independently specified content"]}
  }]
}
```

For managed or remotely shared self-hosted workspaces, use the HTTPS control-plane origin, `workspaceId`, and a dedicated test operator’s native session token. Shared artifact readback can use `{"file":"report.md","contains":["expected content"]}` instead. A resumed trial uses the same submission identity, so the coordinator returns its original durable run. The runner stops for unresolved effects and leaves the evidence file intact.

The runner deliberately records effect counts as **unknown**. Independently audit each dedicated destination for unauthorized writes and duplicate submissions. Add actual counts and `effectAudit` evidence to each trial; a zero count without audit evidence cannot pass. Do not infer absence of writes from missing local logs. Retain the full raw timings, action receipts, source snapshots, test output, checked destinations and human rubric assessments separately with access controls.

Record the exact accepted commit as `sourceRevision`. Merge the trials with `recovery`, `isolation`, `devices`, `deployment`, and `performance` evidence arrays described in `release/acceptance.ts`. Each entry needs `id`, `passed` and a real evidence reference. Recovery/isolation IDs are prefixed by `managed/` or `self-hosted/`. Device IDs are macos/windows/linux/ios/android, with `physical:true`; exercise sign-in, background work, reconnect, notifications, approvals, handoff, installation and restoration. Performance evidence additionally names the host and fixed network profile. Exercise every failure case, encrypted restore onto a fresh host, upgrade/downgrade refusal, rollback, and actual VM isolation with the selected provider adapter.

`npm run acceptance -- report --evidence RELEASE_EVIDENCE.json` produces a reviewable gate report and exits nonzero while any requirement is missing. It reports cold/warm p50/p95 by edition, workflow, host and model. p95 acknowledgement must be within 1 second and prewarmed dispatch within 2 seconds; separately prove readiness/approval API responsiveness while Docker stalls and desktop responsiveness under the fixed network profile. The report does not provision, select a provider, publish a release, or substitute for physical/live evidence.

Public release CI requires the reviewed `release-experience-evidence` artifact from `OPEN_HARNESS_ACCEPTANCE_RUN_ID`. Its `release-evidence.json` must pass every gate and match the tag’s exact source revision. Without it, publication stops before image builds. Private development and acceptance builds remain available without asserting release readiness.
