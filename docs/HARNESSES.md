# Harnesses and private machine files

Open **Agent settings → Computer** to select the local computer or a paired runner. In
**Harness**, choose Hermes, OpenCode, or an installed custom harness. Availability belongs
to that computer. Use **Install OpenCode** for the built-in ACP adapter, or upload a custom
ZIP package and choose **Install and test**. Once ready, select its version and save the
profile. Saving affects the next task; running work retains its snapshot.

OpenCode is pinned to **1.2.27**, ACP protocol **1**, and the managed policy hook contract
in that release. Its container derives from the pinned managed Hermes base to retain Node,
Python, tini, folder verification, and container utilities. Hermes itself is not launched
for OpenCode tasks. Source references: [ACP implementation](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/acp/agent.ts),
[plugin hooks](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/plugin/src/index.ts).

OpenCode resolves each flattened MCP tool name against the configured server names.
If more than one server matches, the call is denied even when one matching tool is
granted. Other grants in the connector profile continue to work. When scoped tool
review is enabled, an unclassified call waits for a coordinator approval before
dispatch. OpenCode's native permission is set to allow for that reviewed call so
the operator sees one approval. Classified granted tools keep OpenCode's native
permission prompt. A successful call sends a coordinator receipt. If execution
fails before the completion hook, later unclassified calls are blocked and the
unconfirmed action is marked uncertain when the run ends. A remote runner must
advertise `opencode-policy-v2` before it can receive an OpenCode task.

## Upload files

In **Harness → Files**, select Working files, Harness configuration, or Harness package.
You can also open this screen from **Workspace files → Upload to …’s computer**. Files
are private to that agent and delivered to its assigned computer. Folder upload preserves
relative paths. Uploading a package never executes it; installation is a separate action.

Working files appear at `/workspace/uploads`. Downloads here return the stored upload
revision; agents may edit their working copies during tasks. Configuration versions appear at
`/workspace/harness-config/<revision>/`; choose **Use configuration** and save the profile.
Custom adapters receive the selected path as `OPEN_HARNESS_CONFIG_DIRECTORY`. Generated
prompts, tool policy, run leases, and credentials live separately and cannot be replaced
by uploads. A configuration upload is data: the adapter decides which declared inputs
it understands. The managed OpenCode policy and provider selection always take precedence.

Uploads use 1 MiB chunks, per-chunk and final SHA-256 checksums, and a durable receipt list.
Pause or close the app, then reselect the same file to resume an incomplete upload. Delivery
continues with the browser closed once the upload finishes. Reconnect an offline machine
to continue delivery. Assignment changes invalidate an upload bound to its old computer.
Explicitly enable replacement when a path exists. Files publish between runs. Cancellation
discards incomplete uploads; incomplete uploads expire after seven days without activity.

Defaults: **20 GiB/file**, **100 GiB/computer**. Set `OPEN_HARNESS_MAX_FILE_BYTES` and
`OPEN_HARNESS_MACHINE_FILE_QUOTA` in bytes on the coordinator and runners to change them.
Staging and installation additionally require available disk space. Historical configuration
and installed package versions remain retained while referenced. Large downloads stream to
disk with the browser’s Save File API; browsers without it support downloads up to 100 MiB.
Chunks travel through the direct API, dashboard proxy, or cloud relay without increasing
their request limits. Runner delivery is encrypted and bound to one agent, file, and machine.

Agent moves stage current working files, configuration, and packages before changing the
assignment. The destination must install the selected harness and verify every file.
A failed move leaves the source assignment and source files intact. OpenCode's config, data,
cache, and home folders are created fresh for every launch and removed afterwards, so it never
loads a plugin or tool binary from agent-writable storage. Native caches under
`/workspace/private/.harness` stay on the source and regenerate on the destination;
application conversation history is supplied to the new session. Native sessions are
kept separate by harness; switching never translates a native session database.

## Custom package contract

A ZIP contains `harness.json` plus payload files. The machine-readable schema is [harness-package.schema.json](harness-package.schema.json). Use schema version 1 and declare:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `version`, `license` | Stable identity and immutable version |
| `architecture` | Supported Node architecture names: `x64`, `arm64` |
| `image` | Registry image pinned with `@sha256:…`, or `sha256:…` image ID with an untagged archive |
| `imageArchive` | Optional path to an untagged, uncompressed Docker image archive |
| `command` | Executable and argument array, run inside the managed container |
| `protocol` | `open-harness-runtime/v1` (ACP is used by the built-in OpenCode adapter) |
| `features`, `providers` | Supported capabilities and model providers |
| `files` | Every payload path mapped to its SHA-256 digest; exclude `harness.json` |
| `configuration` | Relative configuration inputs understood by the adapter |

Keep runtime caches and native session databases under `/workspace/private/.harness/<id>`;
put lasting working files in `/workspace/uploads`.

Image archives must contain no repository tags or OCI reference-name annotations, so installation
cannot replace another agent’s image. The example packager removes these automatically.

Payload mounts read-only at `/opt/open-harness/package`. Images must supply Node, `/bin/sleep`,
`/usr/bin/tini`, `/usr/local/bin/python` (for verified host-folder mounts), and `cat`.
No package-provided container flags, mounts, host install scripts, or privileged execution
are accepted. The operator trusts the harness code to implement its advertised tool policy;
container isolation remains enforced by Open Harness. A self-test establishes protocol
compatibility, not a security audit of arbitrary uploaded code.

The JSON-RPC transport is newline-delimited JSON on standard input/output. Send
`{"method":"event","params":{"type":"gateway.ready","payload":{}}}` on startup.
Implement:

| Method | Result / behavior |
| --- | --- |
| `runtime.initialize` | `{protocol:"open-harness-runtime/v1",policyEnforced:true}` |
| `runtime.selfTest` | `{deniedTool:true,deniedExpiredLease:true,cancellation:true}` after exercising those guards |
| `session.create` | `{session_id:string}`; accepts `cwd` and prior app `messages` |
| `prompt.submit` | `{text:string}` on completion, or `{status:"streaming"}` followed by `message.complete` |
| `session.interrupt` | Stop active work and resolve pending approvals |
| `approval.respond` | Apply the identified approval; unrecognized choices deny |
| Optional `session.steer`, `clarify.respond`, `model.options` | Expose only when supported |

Events use `{method:"event",params:{type,session_id,payload}}`. Supported types include
`message.delta` (`text`), `tool.start`/`tool.complete` (`id`, `name`), `approval.request`
(`request_id`, `command`), and `message.complete` (`text`, `status`). Logs go to stderr. Initialization points to `/run/open-harness/runtime-context.json`,
which supplies the selected model, MCP server configuration, instructions, and file locations.
Apply the file named by `instructions` as the agent's system prompt, and read it again for
each `session.create`: it carries the agent's name, role, the operator's instructions, its
folders and API grants, and changes whenever the profile does.
Installation probes supply `probe:true` and `model:null`; initialization must not start inference.
A harness advertising MCP support must implement `runtime.probe` for connection checks;
this receives the check action and selected connector arguments inside its container.
Before every dispatch, enforce `/run/open-harness/policy.json`’s exact `allowedTools` and
the active, unexpired, matching run in `/run/open-harness/run-lease.json`. Empty means
no tools. Unknown tools are disabled. Cancellation must stop detached processes too;
Open Harness stops the container before releasing its execution slot.

The runnable echo example is in `examples/harness/adapter.mjs`. To produce a package
including an existing local runtime image (Python 3 and Docker required for packaging):

```bash
python3 examples/harness/package.py --image open-harness-hermes:2026.9.11 --output /tmp/echo-harness.zip
```

## APIs and runner compatibility

- `GET /v1/harnesses?machineId=…`: machine-specific inventory and readiness.
- `POST /v1/machines/:id/harnesses/install|test`: `{agentId,kind,fileId?,version?}`;
  returns a durable job inspected through `GET /v1/harness-jobs/:id`.
- `POST /v1/agents/:id/uploads`: `{path,destination,size,checksum,machineId?,replaceId?,replaceExisting?}`.
- `GET /v1/agents/:id/uploads/:uploadId`: metadata, chunk size, and received indexes.
- `PUT /v1/agents/:id/uploads/:uploadId/chunks/:index`: `{data:<base64>,checksum}`.
- `POST /v1/agents/:id/uploads/:uploadId/finalize|cancel`.
- `GET /v1/agents/:id/files`, `GET|DELETE /v1/agents/:id/files/:fileId`, and
  `GET /v1/agents/:id/files/:fileId/chunks/:index`.

All app routes require existing operator/workspace authorization. File bytes are absent
from durable runner commands. New runners advertise `agent-harnesses` and `agent-files`;
older runners remain Hermes-only and must be updated to receive uploads or other harnesses.
