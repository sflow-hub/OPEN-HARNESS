# Group chat, server-side conversations, and async messaging

Status: design proposal (no code in this change). Targets `0.4.0-beta.x`.
Scope: conversations shared by multiple agents + the user, a turn policy for who speaks
next, non-blocking delegation, a durable async inbox, server-side conversation storage with
session resumption, deadlock-free admission, loop/rate/cost guards, and migration off browser
`localStorage`.

All claims about current behavior cite `path:line`. Line numbers are against the tree at the
time of writing; treat them as anchors, not contracts.

## 1. Why

Three gaps block the owner's goal of persistent teammates that talk to each other:

1. **Delegation blocks a coordinator connection for up to 30 minutes.** `/internal/handoff`
   calls `waitForRun(child.id)` and only responds when the child run reaches a terminal state
   (`runtime/service.ts:778`), and `waitForRun` polls every 500 ms until the child finishes or
   30 minutes pass (`runtime/service.ts:366`–`374`). The calling agent's turn is held open the
   entire time, and the coordinating agent's admission slot with it.
2. **There is no multi-party conversation.** A run is one agent, one prompt, one
   `conversation_id` that defaults to a fresh UUID when the caller omits it
   (`runtime/service.ts:389`). The `conversations` table stores a single `agent_id` per row
   (`runtime/db.ts:70`–`73`). Nothing models "these agents and the user share a thread."
3. **History is a browser artifact.** The dashboard keeps conversations in `localStorage`
   (`app/page.tsx:240`, written back at `app/page.tsx:380`) and every new run starts without a
   `session_id` so Hermes mints a fresh session each time (`runtime/service.ts:291`). Context
   lives in one browser; a second client, a restart, or a headless caller sees nothing.

## 2. Current state (evidence)

| Concern | Where | Behavior today |
| --- | --- | --- |
| Conversation storage | `runtime/db.ts:70`–`73` | One `agent_id`, `title`, `legacy_json`; no members, no kind |
| Run → conversation link | `runtime/service.ts:389` | `conversation_id` optional, defaults to `crypto.randomUUID()` |
| Session resumption | `runtime/service.ts:291`–`295` | Reuses `run.session_id` if set, else `session.create`; stored back on the run |
| Delegation (blocking) | `runtime/service.ts:778` | `createRun(... parentRunId)`, then `await waitForRun(child.id)` |
| Wait loop | `runtime/service.ts:366`–`374` | 500 ms poll, 30-min cap, throws if still active |
| Admission pump | `runtime/service.ts:310`–`327` | `activeCount() < 4`, `activeTopLevelCount() < 2`, `agentBusy` gate |
| Busy / active counters | `runtime/db.ts:138`–`140` | `running`, `waiting_approval`, `waiting_input` count as active |
| Depth + cycle limits | `runtime/service.ts:381`–`386` | `depth > 2` rejected; ancestor agent reuse rejected |
| Delegation grant | `runtime/service.ts:778`, `runtime/teams.ts:127`–`130` | `internalAllowed` + `sharesActiveTeam` |
| Agent auth | `runtime/service.ts:96`–`99` | Bearer token per agent, `timingSafeEqual` |
| Event log | DDL `runtime/db.ts:81`–`84`; methods `runtime/db.ts:149`–`158` | Append-only `events(seq, id UNIQUE, run_id, type, payload_json)`; read with `seq > after` |
| Coordination MCP tools | `runtime/hermes/coordination.mjs:9`–`25` | `task`, `delegate_named_agent`, `create_open_harness_routine` |
| Browser → server migration | `runtime/service.ts:643`–`657` | One-shot `/v1/migrate`, `browser-v1` key, backup file |

## 3. Participants model

Conversations become first-class and multi-party. Direct chats (user ↔ one agent) are the
degenerate group of size one agent.

```
conversation ──< conversation_members >── participant (agent | user)
      │
      └──< messages (each message has one sender member)
```

- `kind`: `direct` or `group`. A `direct` conversation has exactly one agent member plus the
  user; a `group` has ≥1 agent member plus optional user.
- A **member** is a `(conversation_id, participant_kind, participant_id, role)` row.
  `participant_kind ∈ {user, agent}`. The single local operator is `participant_id = 'user'`
  (there is one trusted operator per `SECURITY.md:5`, so we do not model multiple humans).
- **Roles**: `owner` (the user, always), `moderator` (drives turn order; may be the user or a
  designated agent), `member` (speaks when addressed or when round-robin reaches them),
  `observer` (receives deliveries, never takes a turn — useful for an audit/reviewer agent).
- Membership is the authorization boundary for reading and posting. It is checked against
  `conversation_members`, and additionally, for agent-to-agent visibility, the existing
  `teams.sharesActiveTeam` rule is reused so a group cannot smuggle an agent past team scoping
  (`runtime/teams.ts:127`–`130`). Adding an agent member requires that the adder (user, or a
  moderator agent acting on a grant) and the target share an active team, mirroring the current
  handoff guard (`runtime/service.ts:778`).

### 3.1 Per-message sender identity

Every message records its sender as a member reference plus a denormalized display identity, so
provenance survives even if a member is later removed:

- `sender_kind` (`user` | `agent` | `system`), `sender_id` (agent id or `user`),
  `sender_name` (snapshot of the profile name at send time).
- `system` messages are turn-control and lifecycle notices (joins, kills, round boundaries).
  They are never authored by a model and never consume a turn.

## 4. Message model and the async inbox

Two tables: an immutable `messages` log (the conversation's truth) and a `message_deliveries`
fan-out (per-recipient state). This split is what makes delivery idempotent and replay-safe
without rewriting conversation history — the same pattern the event log already uses
(append-only `events`, read with `seq > after` at `runtime/db.ts:155`–`157`).

### 4.1 `messages`

```sql
CREATE TABLE IF NOT EXISTS messages (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT UNIQUE NOT NULL,            -- SERVER-generated uuid, like events.id (runtime/db.ts:150)
  conversation_id TEXT NOT NULL,
  sender_kind   TEXT NOT NULL,                   -- 'user' | 'agent' | 'system'
  sender_id     TEXT NOT NULL,                   -- agent id, or 'user'
  sender_name   TEXT NOT NULL,                   -- snapshot at send time
  body          TEXT NOT NULL,
  idempotency_key TEXT,                          -- caller-supplied dedupe token, scoped to the sender
  mentions_json TEXT NOT NULL DEFAULT '[]',      -- resolved @mention member ids
  in_reply_to   TEXT,                            -- messages.id this answers (delegation result links here)
  origin_run_id TEXT,                            -- run that produced this message, if any
  round_id      TEXT,                            -- turn-round grouping, if any
  source        TEXT NOT NULL DEFAULT 'native',  -- provenance: 'native' | 'browser-v2' | 'backfill' (rollback marker, §10)
  created_at    TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem
  ON messages(conversation_id, sender_kind, sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

**Why the `id` is server-generated.** An earlier draft let the caller pick `id` and made it both
globally `UNIQUE` *and* unique per conversation. Those conflict: with `INSERT OR IGNORE`, a
caller-chosen `id` that already exists in a *different* conversation is silently dropped, and the
`409`/ignore outcome leaks that the id exists elsewhere — a cross-conversation probe. So `id` is
minted by the coordinator exactly as `events.id` is (`runtime/db.ts:150`), and callers never
choose it. Idempotency instead rides a separate `idempotency_key`, deduped **within the sender's
own scope** by the partial unique index above. A retried post (network blip, runner reconnect)
reusing the same key collapses to one row; a key can never collide across senders or
conversations, so it reveals nothing. `message_deliveries.message_id` (§4.2) therefore references
a server-owned value, not a caller-chosen one.

### 4.2 `message_deliveries`

```sql
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id    TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,                  -- 'user' | 'agent'
  recipient_id  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending', -- see state machine
  deliver_after TEXT,                            -- optional backpressure / rate-limit stamp
  consumed_run_id TEXT,                          -- run that read this into context
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY(message_id, recipient_kind, recipient_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deliveries_inbox ON message_deliveries(recipient_kind, recipient_id, state);
```

**Delivery state machine**

```
pending ──(agent turn reads it)──> delivered ──(turn committed)──> consumed
   │                                   │
   │                                   └──(turn failed/cancelled)──> pending   (redelivered)
   └──(recipient removed / conv deleted)──> dropped
```

- `pending` → `delivered`: set transactionally when a recipient's turn selects it for context;
  `consumed_run_id` records which run. Reading does not delete; it marks.
- `delivered` → `consumed`: set when that run reaches a terminal state and its output is
  committed as a new message. Consumption is keyed on `consumed_run_id`, so a duplicate commit
  from a reconnecting runner is a no-op.
- `delivered` → `pending` on turn failure/cancel: the message was never acted on, so it must be
  redeliverable. This is the restart-safety path, and the reset condition has to be chosen
  carefully. On boot the coordinator rewrites `running`/`waiting_*` runs to `interrupted` (`Store`
  constructor's raw `UPDATE`, `runtime/db.ts:116`), and `interrupted` is itself *terminal*, so
  "reset rows whose run is non-terminal" would never fire after a restart. But the mirror-image
  phrasing "reset rows whose run is anything other than `completed`" is also wrong: applied at
  runtime it would reset a row whose `consumed_run_id` is still `running` (not yet terminal, not
  `completed`) and double-deliver the message to a turn still in progress. The reset must name the
  terminal *failure* states explicitly: reset any `delivered` row whose `consumed_run_id` run is in
  `state IN ('failed','cancelled','interrupted')` back to `pending`. A `running`/`waiting_*` row is
  left alone (the turn may still commit), and a `consumed` row (terminal success, output committed)
  is never touched. To close the window between a child reaching `completed` and its reply being
  posted, commit the reply **in the same transaction** as the `completed` write (`setRun`,
  `runtime/db.ts:151`); failing that, the boot sweep (§6.1) re-scans `completed` child runs that
  have no reply and posts one, so a crash between the two steps can never strand the parent.
- `dropped` is terminal and set only by membership removal or conversation delete.

**Idempotency & replay safety.** (1) Posting is idempotent on
`messages(conversation_id, sender_kind, sender_id, idempotency_key)` when the caller supplies a
key; the `id` itself is server-minted (§4.1).
(2) Delivery rows are a deterministic fan-out of a message over current members, so recreating
them is idempotent on the composite PK. (3) Consumption is idempotent on `consumed_run_id`. No
step depends on at-most-once network delivery; the inbox is pull-based (`GET /v1/inbox`), and a
re-read of a still-`pending` row is harmless.

## 5. Turn policy

A conversation has a `turn_policy`: `manual` (user speaks, one agent replies — today's
behavior), `round_robin`, or `moderated`.

### 5.1 Round-robin

Members with role `member`/`moderator` form an ordered ring (insertion order). After a message
commits, the next eligible member in the ring is scheduled for a turn, skipping `observer`s and
any agent currently `agentBusy` (`runtime/db.ts:138`) — a busy agent keeps its slot in the ring
and is retried next pass. A **round** is one full pass of the ring; `round_id` groups the
messages. Round-robin stops at `max_turns_per_round` (default 8) or when a message contains a
`@stop`/empty-turn signal.

### 5.2 @mention addressing

Mentions are parsed against the member list and resolved to member ids stored in
`messages.mentions_json`. A message that `@`-addresses one or more members schedules turns for
exactly those members (if eligible) and suppresses the round-robin advance for that message, so
directed asks do not also wake the whole ring. A mention of a non-member is dropped (and echoed
back in a `system` note) rather than silently added — adding members is an explicit grant.

### 5.3 Moderated loop

A `moderated` conversation names a **moderator** member (agent or user). After each committed
message the moderator decides who speaks next instead of a fixed ring:

- If the moderator is the **user**, the dashboard simply presents "who should reply?" — no
  automatic model turn is scheduled.
- If the moderator is an **agent**, the coordinator runs a bounded *control turn*: the moderator
  agent receives the new message plus the roster and returns a small structured decision
  (`next: <member_id> | stop`, optional `prompt`). The control turn is itself a run subject to
  all admission and rate limits below, and the moderator cannot select itself twice in a row
  (prevents a trivial self-loop).

**Stop conditions (any one ends the round):** `stop` from the moderator; `max_turns_per_round`
reached; `max_rounds_per_conversation_hour` reached; no eligible speaker; the conversation kill
switch (§8) is set; or two consecutive empty/contentless turns (no new content) — a cheap
livelock breaker.

## 6. Non-blocking delegation

Replace the blocking wait at `runtime/service.ts:778` and the 30-minute `waitForRun`
(`runtime/service.ts:366`) with fire-and-forget delegation that returns the child run id
immediately and delivers the result asynchronously into the parent's inbox.

### 6.1 New behavior of `/internal/handoff`

```
POST /internal/handoff
  headers: Authorization: Bearer <agent token>, X-Open-Harness-Agent, X-Open-Harness-Run
  body:    { agentId, prompt, conversationId? }
  → 202 { childRunId, state: "queued", conversationId }
```

- Keeps the existing guards verbatim: the caller must have an active run
  (`internalAllowed`, `runtime/service.ts:220`), the handoff tool must be granted, and caller +
  target must `sharesActiveTeam` (`runtime/teams.ts:127`). None of that changes.
- Creates the child run exactly as today via `createRun(... parentRunId)`
  (`runtime/service.ts:376`), inheriting depth/cycle checks (`runtime/service.ts:381`–`386`).
- **Does not call `waitForRun`.** It returns the `childRunId` and the conversation the result
  will land in. The parent's turn can finish; the coordination socket connection closes in
  milliseconds instead of minutes.
- On **every** terminal transition of the child — not just the happy path — a `messages` row is
  posted (sender = child agent, `in_reply_to` = the delegation message, `origin_run_id` = child
  run) into the delegation conversation (§6.1.1) and deliveries fan out. Hooking the single local
  success handler (`store.setRun(... 'completed')`, `runtime/service.ts:302`) is **not** enough: it
  misses the remote-completion path (`runtime/service.ts:272`) and the failure/cancel/interrupt
  path (`execute`'s `catch`, `runtime/service.ts:307`), so a failed or cancelled child would leave
  the parent waiting forever at the conversation level. Three concrete requirements make the
  listener-based posting sound:

  1. **Chain the listener, never replace it.** `store.runListener` is already taken: `service.ts:52`
     sets it to `run => tasks.syncRun(run)` for task-board sync. A plain "subscribe" would clobber
     that and break the board. The reply poster is *added* to a small fan-out — each state write
     calls both `tasks.syncRun` and the poster — and `setRun` fires that fan-out on every write that
     carries a `state` patch (`setRun`, `runtime/db.ts:151`).
  2. **Boot sweep for the restart case.** Two terminal transitions bypass `setRun` entirely and so
     never reach the listener: the constructor's interrupt of `running`/`waiting_*` runs is a raw
     `UPDATE` (`Store` constructor, `runtime/db.ts:116`), and queued task runs are interrupted by
     another raw `UPDATE` (`TaskStore` constructor, `runtime/tasks.ts:102`), both running before or
     outside `setRun`. This is exactly case B7. So on boot the coordinator runs a one-time sweep:
     for every terminal child run (`parent_run_id IS NOT NULL`) with no delegation reply yet, post
     the reply. Without the sweep a child interrupted at boot never reaches its parent.
  3. **Deterministic idempotency key.** One child can fire several terminal transitions —
     `stopRunTree` sets `cancelled` (`runtime/service.ts:346`) and may then set `interrupted`
     (`runtime/service.ts:353`), and `execute`'s `catch` can set the state again
     (`runtime/service.ts:307`) — so the listener may be invoked more than once for one child. The
     reply is posted with a fixed `idempotency_key = delegation-result:<childRunId>` in the
     coordinator's own sender scope (§4.1), so the partial unique index collapses every one of
     those transitions — and a live post racing the boot sweep — to exactly one `messages` row.
     This is what makes the chaos test's "one `messages` row" hold.

  A child that completes, fails, is cancelled, or is `interrupted` by a restart (`runtime/db.ts:116`)
  therefore produces exactly one reply — a failure just carries the error text instead of a result —
  so the parent always hears back. The message that *consumes* a delegation reply is the parent
  agent's next scheduled turn in that conversation (§9.3), which carries the lineage forward
  (§6.1.2) so the cycle guard still holds across that re-entry.

#### 6.1.1 The delegation conversation

A `direct` conversation has exactly one agent member plus the user (§3), so the child agent is
**not** a member of the parent's direct conversation and cannot post its reply there. Each
delegation therefore uses a dedicated **delegation conversation**: a `kind='group'` conversation
created `INSERT OR IGNORE` the first time a parent delegates to a given child, whose members are the
parent agent (`member`), the child agent (`member`), and the user (`owner`). Its id is
derived deterministically from the delegation (e.g. `delegation:<parentRunId>:<childAgentId>`) so a
retry, a duplicate terminal transition, or the boot sweep all land in the same row. The child posts
its reply here; fan-out creates a `pending` delivery for the parent agent, which schedules the
parent's next turn (§9.3).

This also removes the dependency on the parent having a usable conversation at all. A **task run or
a scheduled run** mints a fresh `conversation_id` that the §9.1 backfill may not have reached, and
neither is a user-facing chat — so "post into the parent's direct conversation" has no valid target
for them. The delegation conversation is keyed off the parent *run*, not its `conversation_id`, so
the reply always has a home and the consuming turn reads it from the inbox exactly as in a group
chat.

#### 6.1.2 Lineage carried across reply re-entry

A reply delivery wakes the parent as a **new depth-0 run with no `parent_run_id`**, so the ancestry
walk in `createRun` (`runtime/service.ts:383`–`386`) cannot see the earlier hop: A delegates to B,
B's reply wakes A at depth 0, and A can delegate to B again — unboundedly. "Depth ≤ 2, finite DAG"
then holds only *per chain*, not across reply re-entry (the only remaining bounds would be the
per-conversation message and rate caps, §8). To close this, a delegation delivery carries a
`delegation_root` (the originating top-level run id) and the accumulated hop depth; the turn that
*consumes* the delivery inherits both, and `createRun` counts a delegation issued from such a turn
against the carried depth and re-runs the ancestry check against the carried lineage rather than the
empty `parent_run_id` chain. Invariant 3 (§7) is then stated to hold **across reply re-entry**: the
total delegation hops rooted at one top-level run are finite, not merely each isolated chain. The
per-conversation caps (§8) remain a backstop.

### 6.2 No synchronous convenience path

An earlier draft offered an `awaitInline: true` option for callers that wanted to block on a
short child. We **drop it.** There is no sound way to "release the parent slot before waiting":
the parent's Hermes turn is the thing making the `/internal/handoff` call, so it is still
`running` and still counts toward `activeCount` and `agentBusy` (`runtime/db.ts:138`–`139`). A
new state that excluded it from `agentBusy` would let the pump admit another run for the same
agent, and `execute` stops that agent's existing gateway (`runtime/service.ts:274`–`275`),
killing the very turn that was waiting; re-acquiring the slot when the child finishes just
reintroduces hold-and-wait. Delegation is therefore async-only: the tool returns the child id,
and the parent reads the reply from its inbox on a later turn (§6.3). This keeps the deadlock
argument in §7 to a single sentence — active runs never hold a wait edge.

### 6.3 Agent-facing tool shape

`delegate_named_agent` (`runtime/hermes/coordination.mjs:16`–`19`) keeps its input. Its
description *already* promises a durable run id ("return the durable run ID",
`runtime/hermes/coordination.mjs:17`); what changes is the runtime behavior behind it — today
the coordinator blocks on `waitForRun` before answering (`runtime/service.ts:778`), and this
design makes it return `{ childRunId, conversationId }` the moment the child is queued, so the
description finally matches the behavior.

The reply is read back with `read_inbox` (§9) or a thin `check_delegation` convenience. **Both
are a single non-blocking read**: they return whatever deliveries are `pending`/`delivered` right
now and return immediately. Neither may `await` a child to finish — an in-turn await would
recreate the exact hold-and-wait §7 removes. An agent that wants a reply simply ends its turn;
the delegated result arrives as an inbox item and schedules its next turn (§4.2, §9.3).

## 7. Deadlock-free admission

Admission caps today: at most 4 active runs total (`runtime/service.ts:313`), at most 2
top-level (depth 0) active (`runtime/service.ts:317`), at most 1 active run per agent
(`agentBusy`, `runtime/db.ts:138`, enforced in the pump filter at `runtime/service.ts:315`), and
per-machine concurrency (`runtime/service.ts:320`–`322`). "Active" = `running` or
`waiting_approval` or `waiting_input` (`runtime/db.ts:139`).

The current blocking handoff is a latent deadlock: a parent in `running` holds a slot while a
child it spawned sits `queued` behind the cap; if the cap is already full of such parents, no
child can start and every parent waits forever (bounded only by the 30-min timeout at
`runtime/service.ts:373`). The design removes this by construction.

**Invariants that make the new design deadlock-free:**

1. **Waiting-for-a-reply is not an active state.** After a non-blocking delegation the parent
   run *completes its turn* and leaves the active set; it holds no slot while the child works.
   A conversation waiting on a delegated reply is represented purely in `message_deliveries`
   (`pending`), which consumes no admission capacity. This is the core change: capacity is only
   ever held by work that is actually executing, never by work that is waiting on other work.
2. **No run both holds a slot and blocks on another run.** The only place a run blocked on a
   child (`runtime/service.ts:778` → `366`) is deleted, and there is no `awaitInline`
   replacement (§6.2 explains why one cannot be made sound). Agent-side reply reads
   (`check_delegation`/`read_inbox`, §6.3) are single non-blocking calls, never in-turn awaits,
   so a turn never parks itself on another run while holding its slot.
3. **Fan-out is bounded.** Depth ≤ 2 (`createRun`, `runtime/service.ts:382`) and cycles are
   rejected (ancestry walk, `runtime/service.ts:383`–`386`); a turn may enqueue at most
   `max_delegations_per_turn` (default 3) children. The child-run graph is a finite DAG, so the
   dependency graph among *active* runs has no cycle — and with invariant 1 there are no wait edges
   among active runs at all. Because a reply wakes the parent as a *fresh* depth-0 run (§6.1.2), the
   depth-2/DAG bound holds **across reply re-entry only** when the delivery's `delegation_root` and
   hop depth are carried forward and re-checked in `createRun`; without that carry-forward the bound
   would hold per chain but not across replies. With it, the delegation hops rooted at any one
   top-level run are finite.
4. **Admission is oldest-first among *eligible* runs, and starvation-bounded.** `queued()`
   orders by `created_at` (`runtime/db.ts:131`), but the pump does not admit strictly in that
   order: it `.find`s the oldest run that also passes every eligibility gate
   (`runtime/service.ts:314`) — not `agentBusy`, not stopping/transferring, under the task-run
   cap `maxTaskRuns = 3` (`runtime/service.ts:66`, `:316`), under the top-level cap for depth-0
   runs (`runtime/service.ts:317`), and within per-machine concurrency. So it is "oldest
   eligible", not FIFO. That is still starvation-bounded: an ineligible run only waits on a
   *condition* (a busy agent, a full machine) that some terminating active run clears, never on a
   younger queued run, so no run is passed over forever.
5. **Admission is single-threaded.** `pump()` guards with `pumping` (`runtime/service.ts:311`)
   so counting and starting cannot interleave; the counts it reads (`runtime/db.ts:139`–`140`)
   are a consistent snapshot.
6. **Human-blocked states are an explicit assumption, not a guarantee.** `activeCount` treats
   `waiting_approval` and `waiting_input` as active (`runtime/db.ts:139`), and a run paused on an
   approval keeps its slot (`CLAUDE.md`). These do **not** make progress on their own — they wait
   on the operator. Four runs parked on approvals can occupy all four slots indefinitely. The
   deadlock argument below therefore holds *only* for automatic progress; human-blocked runs are
   a liveness dependency on the human. To bound it we add an optional `approval_timeout` that,
   on expiry, releases the slot by `stopRunTree` (`runtime/service.ts:705`) and posts a `system`
   note, so an unattended chat cannot wedge the whole coordinator. This is a real limit, stated
   openly, not something the proof hides.

**Depth and caps for turn runs.** An auto-turn run scheduled by the turn policy (§5) and a
moderator control turn (§5.3) are created at **depth 0**, so each consumes one of the two
top-level slots (`runtime/service.ts:317`) and is subject to the same admission as a user-started
run. Delegated children created *inside* a turn run are depth > 0 and bypass the top-level cap
(`runtime/service.ts:317`), bounded instead by the depth-2 limit (`runtime/service.ts:381`) and
`max_delegations_per_turn`. Stating this matters: a large group does not get unlimited
concurrency; its turns serialize through the two top-level slots.

**Sketch of the proof (automatic progress).** Model active runs as nodes and "A is blocked on B"
as edges. Deadlock requires a cycle of blocked runs each holding a resource another needs. With
invariants 1 and 2 the active set has *no* outgoing wait edges (a waiting conversation is not an
active run, and no turn awaits another run while holding its slot), so the blocked-on graph over
active runs is empty — vacuously acyclic. Assuming the operator answers or times out any
human-blocked run (invariant 6), at least one active run is always runnable to a terminal state;
on its completion a slot frees; by invariant 4 the oldest *eligible* queued run admits. Progress
is guaranteed; no reachable state is an automatic deadlock. ∎

The per-agent and per-machine caps can still cause *queueing* (a ring of 6 agents with 4 slots
serializes), but queueing is not deadlock: the ring advances one agent at a time and each turn
terminates (§8 bounds it), so the round always completes.

## 8. Loop, rate, cost, and kill controls

Stored per conversation (defaults in parentheses; all overridable per conversation, clamped to
hard maxima):

| Control | Default | Hard max | Enforced |
| --- | --- | --- | --- |
| `max_turns_per_round` | 8 | 32 | Turn scheduler ends the round |
| `max_rounds_per_conversation_hour` | 20 | 60 | Scheduler refuses new rounds, posts a `system` note |
| `per_agent_messages_per_minute` | 10 | 30 | `deliver_after` backpressure stamp; over-cap turns are deferred, not dropped |
| `max_delegations_per_turn` | 3 | 5 | Checked in `/internal/handoff` before `createRun` |
| delegation depth | 2 | 2 | Existing check (`runtime/service.ts:381`) |
| `max_total_messages` | 500 | 5000 | Round scheduler halts auto-turns; manual still allowed |
| cost guard (`max_turn_minutes` per turn) | 20 | 60 | **New** per-turn deadline, enforced by the turn scheduler |

- **Kill switch.** A conversation has `auto_turns_enabled` (bool) and an operator
  `POST /v1/conversations/:id/halt` that (a) sets it false, (b) cancels any scheduled-but-not-
  started turns, and (c) runs `stopRunTree` on in-flight turn runs (reuses
  `runtime/service.ts:705`). A global kill is the existing `/v1/runs/stop-all`
  (`runtime/service.ts:708`). Halting disables *automatic* turns only; the user can still post.
- **Rate limiting** is advisory-by-deferral, never silent drop: an over-rate turn gets a
  `deliver_after` in the future and is picked up when the window reopens, so no message is lost.
- **Livelock breaker.** Two consecutive empty/no-new-content turns end the round (§5.3).
- **Per-turn cost guard.** There is no per-run wall-clock cap today to reuse: `submitPrompt`
  defaults to a 24-hour timeout (`runtime/hermes.ts:106`), and the only 30-minute cap was
  `waitForRun` (`runtime/service.ts:366`), which §6 deletes. So `max_turn_minutes` is a *new*
  deadline the turn scheduler applies to each auto-turn run: on expiry it calls `stopRunTree`
  on that run (`runtime/service.ts:705`) and posts a `system` note, rather than relying on a
  non-existent run-level timeout.

## 9. Server-side conversations, context, and session resumption

### 9.1 Storage

Extend the existing `conversations` table rather than replace it (it already carries
`legacy_json` for imported history, `runtime/db.ts:70`–`73`):

```sql
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct';        -- via addColumn()
ALTER TABLE conversations ADD COLUMN turn_policy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE conversations ADD COLUMN auto_turns_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN limits_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'native';   -- 'native' | 'browser-v2' | 'backfill' (rollback marker, §10)

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  participant_kind TEXT NOT NULL,                -- 'user' | 'agent'
  participant_id  TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',-- owner | moderator | member | observer
  session_id      TEXT,                          -- per-agent Hermes session for this conversation
  joined_at       TEXT NOT NULL,
  removed_at      TEXT,
  PRIMARY KEY(conversation_id, participant_kind, participant_id),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conv_members_agent ON conversation_members(participant_kind, participant_id);
```

Column adds use the existing `addColumn` helper, which is a no-op when the column already exists
(`runtime/db.ts:45`–`50`); the new tables follow the `CREATE TABLE IF NOT EXISTS` convention and
`PRAGMA foreign_keys=ON` already set at `runtime/db.ts:59`.

**Keep the schema additive; do not bump `SCHEMA_VERSION`.** `SCHEMA_VERSION` is a hard gate:
a build refuses to open any database whose `user_version` is *newer* than the build understands
(`SchemaTooNewError`, `runtime/db.ts:61`). Bumping it would mean that once a user upgrades, an
older binary can no longer open their data at all — so a "roll back to the previous build"
recovery path becomes impossible. Because every change here is a pure addition (`ADD COLUMN` with
defaults, new `CREATE TABLE IF NOT EXISTS`), an older binary that simply ignores the new columns
and tables still operates correctly on the rows it knows. So we leave `SCHEMA_VERSION` at its
current value (`runtime/db.ts:33`) and gate the projection on a `migrations`-table key instead
(§10). The trade-off to document plainly: an older build keeps *working*, but it will not
populate or honor the new tables, and any group chat created on the new build is invisible to it.

**`messages` needs a `conversations` row to point at.** The `FOREIGN KEY` to `conversations(id)`
is only satisfiable if a matching row exists — but today `createRun` mints a fresh
`conversation_id` UUID and **never inserts a `conversations` row** for it
(`runtime/service.ts:389`); the table is only populated by the browser import
(`runtime/service.ts:653`). So most live `runs.conversation_id` values have no backing row. Phase
1 therefore includes a **backfill**: insert a `conversations` row (and a default
`conversation_members` pair of the run's `agent_id` + `user`) for every distinct
`runs.conversation_id` that lacks one, `kind='direct'`. Going forward, `createRun` is extended to
`INSERT OR IGNORE` the conversation row when it mints a new id, so the invariant holds for new
runs too.

`agent_id` on the legacy `conversations` row stays as the direct-chat's single agent so old
reads keep working; `kind='group'` rows treat it as the creator and defer to
`conversation_members` for truth.

### 9.2 Session resumption

Today a run resumes only if `run.session_id` is already set, otherwise Hermes opens a fresh
session (`runtime/service.ts:291`). We give each **agent member** its own durable session per
conversation (`conversation_members.session_id`). When a turn run for agent A in conversation C
starts, `createRun` seeds `run.session_id` from `conversation_members.session_id` for `(C, A)`;
the first turn creates it and writes it back (the store-back already happens at
`runtime/service.ts:295`). Result: an agent keeps continuity across turns and across restarts,
and a reopened dashboard sees the same thread because it is server-side, not `localStorage`.

**Unverified dependency.** This assumes a stored `session_id` actually resumes prior context in
Hermes. But `execute` stops and recreates the agent's gateway at the start of every run
(`runtime/service.ts:274`–`275`), so a reused `session_id` is handed to a *fresh* gateway
process. Whether a Hermes session survives a gateway restart — i.e. whether `session.create` is
skipped and history is genuinely rehydrated from the id — is not something the current code
proves. Treat per-member `session_id` as the right data model, but gate any reliance on it behind
an explicit real-runtime check (added to `runtime/VERIFICATION.md`); if sessions do not rehydrate
across a gateway restart, context must instead be rebuilt from the transcript window (§9.3), which
this design already assembles server-side and does not depend on Hermes session state.

### 9.3 Building an agent's turn context (membership + provenance checks)

For agent A's turn in conversation C, the coordinator assembles context server-side:

1. **Authorize.** A must be a current member of C (`conversation_members`, `removed_at IS NULL`)
   with a turn-taking role, and for any agent-authored content to be visible, A and the author
   must `sharesActiveTeam` (`runtime/teams.ts:127`) — a removed or non-team agent's messages are
   excluded even if still in the log.
2. **Select inbox.** All `message_deliveries` for A in C in state `pending`, oldest first,
   transitioned to `delivered` with `consumed_run_id = run.id` in the same transaction.
3. **Prompt assembly.** The run `prompt` is the rendered transcript window (bounded by
   `max_total_messages` / a token budget), each line tagged with `sender_name` and
   `sender_kind` so the model can tell who said what. Provenance tags are server-authored, not
   agent-authored, so one agent cannot spoof another's identity in the transcript.
4. **Commit.** On terminal success, A's answer is posted as a new `messages` row (sender = A),
   the consumed deliveries flip to `consumed`, and fan-out creates `pending` deliveries for the
   other members — which is what advances the turn policy (§5).

Everything an agent sees passes a membership check and a team-scope check; nothing is read
straight from `localStorage` or trusted from the agent's own claims.

## 10. Migration from browser `localStorage`

The one-shot `/v1/migrate` path already exists and is idempotent on the `browser-v1` key
(`runtime/service.ts:643`–`646`), imports agents and conversations as `legacy_json`
(`runtime/service.ts:653`), and writes a `browser-v1-backup.json` (`runtime/service.ts:655`).
The dashboard calls it once, gated by `MIGRATED_KEY` (`app/page.tsx:285`–`288`). We extend, not
replace, that path:

1. **Import (additive).** A follow-on migration `browser-v2` reads each `conversations.legacy_json`
   row and projects it into the new shape: one `conversation_members` row for the stored
   `agent_id` plus the `user`, and one `messages` row per legacy message. Live chats are handled
   by the §9.1 backfill. Migration is the one path where the coordinator does *not* mint a fresh
   `id`: legacy messages have no stable id, so it synthesizes a deterministic
   `id = sha1(JSON.stringify([conversation_id, index, role, body]))`. The input is length-delimited
   (JSON-encoded), **not** raw `||` concatenation: direct concatenation is ambiguous — `("ab","c")`
   and `("a","bc")` would hash identically — whereas the JSON encoding keeps every field boundary
   distinct, so re-projection lands on the same row and distinct messages never collide.
2. **Dedupe.** Message insert is `INSERT OR IGNORE`, which collapses on the globally `UNIQUE`
   `messages.id` (same guard style as the existing conversation import `INSERT OR IGNORE` at
   `runtime/service.ts:653`). Because the synthesized id folds in `conversation_id`, it is unique
   across conversations, so projecting twice is safe and cannot collide with another thread.
3. **Rollback is a forward step, never a version downgrade.** Because the schema is additive and
   `SCHEMA_VERSION` is untouched (§9.1), rolling back the *projection* does not require an older
   binary or a lower `user_version`. The raw import stays untouched in `conversations.legacy_json`
   and `browser-v1-backup.json` (`runtime/service.ts:655`). "Undo" is a forward operation the
   current build runs, but it must delete **only** the rows this projection wrote. `messages` and
   `conversations` therefore carry a `source` provenance column (`'browser-v2'` for projected
   messages, `'backfill'` for backfilled conversation rows, `'native'` for everything created live;
   §4.1, §9.1): the undo deletes `messages`/`conversations` where `source IN ('browser-v2',
   'backfill')` plus their dependent `message_deliveries` / `conversation_members`, then deletes the
   `browser-v2` row from the `migrations` table so the projection can run again later. Without the
   marker a blind "delete the projected rows" could not tell a projected row apart from a *native*
   message or conversation created after cutover, and would destroy live data. The legacy JSON and
   the browser copy remain the source of truth; no destructive step runs against `legacy_json`.
4. **Keying and ordering.** `browser-v2` is **not** a `MIGRATIONS` array entry — those are keyed
   by `user_version` and applied by version comparison (`runtime/db.ts:38`, `:109`), so a
   string key like `browser-v2` would mean nothing there and clearing it would undo nothing.
   Instead it reuses the `migrations` **table** key mechanism that `browser-v1` already uses
   (`SELECT ... WHERE key='browser-v1'`, insert-once, `runtime/service.ts:644`–`646`): the
   projection checks for a `browser-v2` row, runs once, and records it. Ordering is enforced by
   requiring the `browser-v1` row to exist first (it is what created the `legacy_json` the
   projection reads).

## 11. API surface

User/dashboard routes are authorized by the bootstrap control token, checked by `authenticated`
with `timingSafeEqual` (`runtime/service.ts:87`–`90`) and served only to a loopback `Host`
(`SECURITY.md:7`). Agent-facing routes stay under `/internal/*` with the per-agent Bearer token
checked by `authenticatedAgent` (`runtime/service.ts:96`–`99`) and the run-scoped
`internalAllowed` check (`runtime/service.ts:220`).

User/dashboard routes:

```
POST   /v1/conversations                 { kind, title, members:[{kind,id,role}], turnPolicy?, limits? } → conversation
GET    /v1/conversations                 → { conversations }   (membership-scoped)
GET    /v1/conversations/:id             → conversation + members + recent messages
POST   /v1/conversations/:id/members     { kind, id, role }    → 201 | 403 (team scope)
DELETE /v1/conversations/:id/members/:mid                      → 200  (sets removed_at, deliveries→dropped)
POST   /v1/conversations/:id/messages    { body, mentions?, idempotencyKey? } → 201 message  (server mints id; schedules turns)
GET    /v1/conversations/:id/messages    ?after=<seq>          → { messages }   (seq cursor, like events)
POST   /v1/conversations/:id/halt        → 200  (kill switch, §8)
POST   /v1/conversations/:id/policy      { turnPolicy, limits, autoTurnsEnabled } → 200
```

Agent-facing (coordination) routes:

```
POST   /internal/handoff        { agentId, prompt, conversationId? }               → 202 { childRunId, conversationId }   (non-blocking; §6)
POST   /internal/message        { conversationId, body, mentions?, idempotencyKey? } → 201 message   (post into a conversation the agent belongs to; server mints id)
GET    /internal/inbox          ?conversationId?                                   → { deliveries, messages }  (pending items for this agent)
POST   /internal/inbox/ack      { messageIds[] }                                   → 200   (explicit consume; also happens on turn commit)
```

`/internal/message` and `/internal/inbox` enforce: run is active (`internalAllowed`,
`runtime/service.ts:220`), the agent is a current member, and `sharesActiveTeam` for every other
agent member (`runtime/teams.ts:127`). Posting is idempotent on the caller's `idempotencyKey`
within its own sender scope (§4.1); the message `id` is server-minted. `/internal/inbox/ack`
only transitions deliveries whose `(recipient_kind, recipient_id)` is the calling agent, so one
agent can never ack — or probe — another's inbox.

### 11.1 Coordination MCP tools and grants

Extend `runtime/hermes/coordination.mjs:9`–`25`:

| Tool | Route | Grant (allowlist id) |
| --- | --- | --- |
| `delegate_named_agent` (updated: returns run id) | `/internal/handoff` | `HANDOFF_TOOL` (`lib/agent-profile.ts:72`) |
| `post_message` (new) | `/internal/message` | new `MESSAGE_TOOL` |
| `read_inbox` (new) | `/internal/inbox` (+ ack) | new `MESSAGE_TOOL` |

New tools start **disabled** by default and compile into the explicit allowlist exactly like the
existing coordination tools (`CLAUDE.md` security note; `lib/agent-profile.ts:71`–`77`). The
managed Hermes extension already filters model-visible tools and rejects disallowed dispatch, so
an agent without `MESSAGE_TOOL` cannot call the inbox even if it guesses the route — the
coordinator re-checks `internalAllowed` server-side regardless.

## 12. Test plan

**Unit (`node:test`, `OPEN_HARNESS_MOCK=1`, no paid inference):**
- Delivery state machine: `pending→delivered→consumed`; failure resets `delivered→pending`;
  removal → `dropped`; double-consume on the same `consumed_run_id` is a no-op.
- Idempotent post: same `idempotencyKey` from the same sender twice → one row; the server mints
  `id` (a client cannot choose or probe it); the same key from a *different* sender is a distinct
  row.
- Delegation result delivery fires on **every** terminal child transition (complete, fail,
  cancel, interrupt), not only success — assert a failed child still posts a reply to the parent
  (§6.1). The chained `store.runListener` fan-out (`setRun`, `runtime/db.ts:151`) is the live hook;
  separately assert the boot sweep posts a reply for a child interrupted by the raw constructor
  `UPDATE`s (`runtime/db.ts:116`, `runtime/tasks.ts:102`) that bypass `setRun`, and that the
  `delegation-result:<childRunId>` idempotency key collapses repeated transitions plus a live/sweep
  race to one `messages` row (§6.1).
- Turn policy: round-robin ring order, `observer` skipped, busy agent retried; @mention
  schedules only addressed members; moderator cannot pick itself twice; every stop condition.
- Admission: assert the invariants of §7 — delegating does not increment `activeCount`
  (`runtime/db.ts:139`) once the parent turn commits; a full ring serializes but terminates.
- Limits: `max_turns_per_round`, per-agent rate deferral, `max_delegations_per_turn`, depth cap
  reuse (`runtime/service.ts:381`).
- Migration: `browser-v2` projection is idempotent; synthesized ids dedupe; rollback leaves
  `legacy_json` and the backup intact.

**HTTP:** each route's happy path + authz failures (non-member post → 403, cross-team add →
403, unauth agent → 401 per `runtime/service.ts:96`); inbox cursor paging by `seq`.

**Browser (Playwright, required for `components/`/`app/` changes per `CLAUDE.md`):** create a
group, post as user, see two agents reply in round-robin; kill switch halts auto-turns; reopen
the page and the thread is present (server-side, not `localStorage`).

**Chaos / restart:** kill the coordinator mid-round. On boot, in-flight turn runs become
`interrupted` (`Store` constructor, `runtime/db.ts:116`) — which is *terminal*, so the reset must key on
`state IN ('failed','cancelled','interrupted')`, not "run is non-terminal" (§4.2); assert their `delivered` deliveries reset to
`pending` and the round resumes without duplicate messages, and a regression test pins that an
`interrupted` run's deliveries are in fact reset (the naive "non-terminal" condition would fail
this). Simulate a reconnecting runner double-posting a delegation result → one `messages` row,
one `consumed` transition.

## 13. Phased rollout

1. **Tables + server conversations behind a flag.** Add `messages`,
   `message_deliveries`, `conversation_members`, column adds; `browser-v2` projection; read path
   only. No behavior change for existing direct chats.
2. **Non-blocking delegation.** Swap `/internal/handoff` to return the child id and deliver
   results to the inbox. This alone removes the 30-min slot-pin.
3. **Group conversations + manual turns.** User-created groups, `post_message`/`read_inbox`
   tools, manual turn policy (user picks who replies).
4. **Automated turn policies.** Round-robin, then moderated loop, with all §8 guards and the
   kill switch wired to `stopRunTree`.
5. **Dashboard migration.** Move the UI off `localStorage` reads (`app/page.tsx:240`) to the
   server routes. After cutover the **server is authoritative**: `localStorage` becomes a
   write-only safety copy that is never read back into the UI, so if the two diverge the server
   wins and the browser copy is only a disaster-recovery artifact. This avoids a stale browser
   silently overwriting server history.

## 14. Open questions

- **Moderator cost.** An agent moderator spends a control turn per message. Is a cheaper
  rules-only moderator (no model call) enough for v1, with the agent moderator opt-in?
- **User presence in `message_deliveries`.** Do we materialize a `user` delivery row (for an
  unread badge) or treat the dashboard's `seq` cursor as sufficient? Leaning toward a cursor to
  avoid a second write path.
- **Token budget vs. `max_total_messages`.** Transcript windowing needs a token estimate; do we
  reuse any Hermes-side counter or approximate server-side?
- **Observer team scope.** Should an `observer` be exempt from `sharesActiveTeam` (audit agent
  across teams) or strictly bound like other members? Current lean: strictly bound.
- **Cross-machine delivery latency.** Paired runners poll (`runtime/runner.ts`); inbox delivery
  to a remote agent inherits that poll interval. Acceptable, or do we need a push nudge?
- **`awaitInline` — resolved: dropped.** The review confirmed there is no sound way to release a
  parent's slot while its own turn is mid-tool-call (§6.2). Delegation is async-only; the proof
  is now "no wait edges, ever." Keeping this here as a settled decision, not an open one.
- **Approval-timeout default.** Invariant 6 makes human-blocked slots a liveness dependency on
  the operator. Should `approval_timeout` be on by default (bounded liveness, at the cost of
  auto-cancelling a slow human) or opt-in (never surprise-cancels, but four parked approvals can
  wedge the coordinator)? Leaning opt-in for direct chats, on-by-default for automated group
  rounds.
