# Working with persistent teammates

Open Harness keeps work, files, memory, profiles, and routines in the coordinator and
agent computers. Closing a browser does not cancel work. The coordinator and execution
host still need power, network access, and the configured model. This is a self-hosted
workspace, not a managed cloud service. After a coordinator restart, interrupted local
work needs review; completed actions are not automatically replayed.

## Set up access from another device

**Workspace settings → Keep working while you’re away** shows the hosting mode and
phone connection controls. A configured HTTPS origin and browser pairing are required
before **Create phone connection link** is available. The link grants operator access,
works once, and expires after five minutes. Copy or share it only with your own device.

The [private-server preset](../deploy/private-server/README.md) provides a Linux Compose
setup behind Tailscale Serve. It retains loopback-only dashboard ports, private engine
networking, and browser pairing. Your phone and any remote runner or webhook sender
must join the permitted tailnet. Setup is a command you choose to run; opening Settings
does not deploy anything or transfer an existing workspace.

In **Phone and notifications**, enable notifications on each device and send a test.
On iPhone or iPad, install the HTTPS dashboard with Safari’s **Add to Home Screen** and
open that app first. Notifications carry generic task status, not transcripts or approval
details. Browser push support, permission, network delivery, and an online coordinator
are required. Approval decisions remain in the authenticated dashboard. Failed deliveries
retry for up to 24 hours in a queue capped at 500 notifications. Delivery is not guaranteed;
check the dashboard when a status is uncertain.

For automatic startup on a local source installation, use `npm run harness:install-service`
and `npm run harness:start`. Sleeping or switching off that computer stops execution.

## Watch, sign in, and teach

Enable **Private agent desktop** in **Agent settings → Computer** on a Linux Docker
execution host, then open the desktop from the agent conversation. **Watch desktop**
shows live frames. **Stop agent and take control** stops current work and grants human
ownership; it is not a transparent pause of the model. Closing the panel keeps human
ownership, so the agent cannot act while you are away. Explicitly release control.

Use the desktop’s click, navigation, scroll, and text controls for sign-in or 2FA. Typed
text is hidden in the input and excluded from recordings; live screen contents can still
show what the application displays. **Release and continue task** creates a continuation
of the prior request that inspects current state before acting. Check uncertain external
submissions rather than assuming a stopped task can safely be replayed. Human ownership
and the original task reference survive coordinator restart; after restart, input stays
blocked until release, and the saved task can be continued explicitly.

**Record demonstration** captures confirmed clicks, navigation keys, and scrolls. Typed
values, URLs, and screenshots are omitted. After finishing, replace coordinates and
placeholders with clear controls, safe parameters, a starting page, and expected results.
Release control and choose **Save draft for review and testing**. A recorded trace is a
draft, not a verified reusable skill. In-progress recordings are held in memory and are
lost if the coordinator restarts. A finished, unsaved draft is lost when its panel closes;
save it before leaving.

## Start with a useful result

The assistant workspace has three guided starters: **Prepare my day**, **Turn saved
material into a brief**, and **Research and draft with my team**. Choose the
accounts and optional teammates, preview the goal, then start it. Prepare my day
requires connected Gmail and Calendar accounts shared with the primary assistant;
material can also be pasted directly. Missing access links back to Connections.
Choosing accounts guides the task; it does not change the agent's saved permissions.
Failed submissions retain the draft and retry identity within that workspace and user.

**Inbox** separates decisions, work in progress and finished results. Connected
actions show the account, destination, exact available content and consequence.
Editing a pending action prepares a replacement and requires a new approval.
For email sends, the preview is read from the saved draft; rich content or
attachments still need inspection when a plain-text preview is insufficient.

Finished results can include reported files, source links and specialist handoffs.
Open files through the workspace and check the actual result before accepting it:
task completion and an agent's reported artifact do not prove that the work is
correct. **Today** shows the latest actual day brief, its time, pending choices,
finished work and standing duties. An older brief is labeled; no calendar content
is fabricated when a brief has not run.

Owners can use **What it knows** to inspect, edit or forget the selected agent's
working notes and personal preferences. Changes check the saved revision and
preserve the draft on conflict. Forgetting notes removes that saved context, not
historical conversations or backups. Notes remain separate between agents.

**Do this again** opens the existing workflow review flow. **Remember this
correction** records feedback and prepares a workflow draft with that correction;
it does not silently edit memory or launch repair work. Disabling **Notify me when
tasks finish** silences completion notifications for that user while retaining
results in the inbox. Decisions, questions and failures can still notify.

Closing the browser does not cancel tasks. The coordinator and execution computer
must remain powered and connected for background work to continue.

## Turn successful work into a routine

Use **Save as workflow** on a completed conversation, or choose completed work under
**Routines → Reusable workflows**. Then:

1. Edit the name, instructions, and success criteria. **Save revision** preserves earlier
   revisions. A conflicting save keeps your draft and names the saved revision.
2. **Mark reviewed**, then **Run workflow test**. This executes the real task with normal
   approval controls; it is not a dry run. Open its conversation for approvals or questions.
3. Check the actual destination or output. Record what you checked in **Test evidence**
   and accept or reject the result. A completed runtime state does not pass the test by itself.
4. **Publish as skill** writes the tested revision to the agent’s managed skills. Configure
   a routine if it should run again automatically.

Editing a workflow or starting another test pauses its routine. Only the latest accepted
test of the reviewed revision qualifies it for publication and normal scheduling. If you
intentionally schedule without an accepted test, select the explicit override and record
a reason; the override remains visible. It does not permit publishing an untested skill.

Calendar routines use selected weekdays, a local time, and an IANA time zone. Missing
spring-forward times are skipped; repeated fall-back times run once at their first
occurrence. Interval routines remain available. The scheduler checks every 30 seconds,
so dispatch is not a second-accurate clock. After downtime it starts one overdue occurrence
per enabled routine and advances to the next future time. Existing legacy routines continue
to work.

For **External event (webhook)**, save the routine and create a scoped credential. Send
POST to the returned path with `Authorization: Bearer <credential>` and a unique
`Idempotency-Key` for each event. Optional JSON `{"context":"event data"}` supplies task
data. With the Compose dashboard proxy, prefix the path with `/api/local`; for a direct
coordinator use the path as returned. Retrying the same event ID does not start another
run, including across restarts. Rotation invalidates the old credential immediately;
only its hash is stored, and normal workflow responses/history omit it. A webhook
credential cannot authorize other operator APIs. This is a general integration endpoint,
not an automatic connection to email, CRM, or chat accounts.

## Collaborate and share browser logins

Enable **Workspace settings → Advanced features** if Teams and Group conversations are
hidden. Create a team, then open **Group conversations** and select its participants. Choose up
to four recipients when requesting replies, or post without starting work. Replies use
the ordinary queue and approvals. Agents can read and post to groups they belong to and
request bounded replies when their coordination tools are enabled. Membership checks,
delegation depth, and cycle limits still apply.

In a private desktop, expand **Share browser logins with teammates**. Each agent must
explicitly join an active team’s browser-sharing group, and all participants must use the
same execution computer. Joining uses the team browser
profile while preserving the agent’s private profile. Opted-in teammates can use the same
cookies and signed-in accounts, so approve this only for accounts they may all access.
Only one participating agent or human can use that browser at a time. Other private
files and model credentials remain separate. Leaving returns the agent to its private
profile; it does not log the remaining teammates out of shared accounts.

## Review reliability and latency

**Review task result** in a conversation records the destination/file checked and whether
the result was accepted or needs changes. **Workspace settings → Performance and results**
shows runtime completion counts, operator review counts, and median/p95 timings for recent
runs. Queue, startup, first output, cleanup, and total time have separate samples. Total
includes approvals and tool work; missing phases are unknown, not zero. Operator outcome
reviews and workflow acceptance are separate records.

Run-event and runner-command delivery use bounded long polling to remove fixed polling
waits. Task runtimes still perform their normal startup and cleanup; no latency parity
with another product is established. Compare matching tasks, models, hosts, tools, and
approval policies, and include your own intervention time and checked success rate.

Automated tests for these additions use scripted/mock execution and browser fixtures.
They cover transport, review gates, persistence, schedule behavior, and UI flows. They
do not establish model reasoning quality, live third-party workflow reliability, actual
iOS push delivery, or successful cloud deployment. Existing runtime-image acceptance
and security requirements remain in force; record real checks in `runtime/VERIFICATION.md`.
