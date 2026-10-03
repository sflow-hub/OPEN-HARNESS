# Self-hosting operations

Open Harness is designed for one trusted operator. A paired browser has operator-level access to agents, files, and saved model credentials. Keep the default loopback binding unless an authenticated HTTPS reverse proxy protects every request.

Allow at least 20 GB of free disk before the first agent-runtime build. Open Harness does not automatically prune user history during the beta, so monitor Compose volume sizes and `docker system df`. Model-provider requests are sent to the provider you configure and may incur charges; Open Harness itself sends no product telemetry.

## Start and verify

The browser archive uses prebuilt images and the launchers described in [Local browser installation](LOCAL_BROWSER.md). Source builds use the following commands from the source release directory:

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Compose requires browser pairing. Use the launcher to open a paired browser. For a manual start, mint a fresh five-minute, one-use code on the trusted host with `docker compose exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs`, then open `http://localhost:3000/#pair=<code>` using the returned `code` value. Do not share the code or put it in a query parameter. A plain dashboard visit cannot obtain an operator token.

The health endpoint returns only `{"ok":true}`. It reports that the dashboard can reach the coordinator; model credentials and the Hermes execution runtime are checked separately in the first-run guide. Follow logs with `docker compose logs -f open-harness` and download a credential-free diagnostic bundle from **Workspace settings → Download diagnostics**.

## Authenticated HTTPS access

Keep port 3000 on loopback when the reverse proxy runs on the same server. Set these values in `.env`:

```dotenv
OPEN_HARNESS_LISTEN_ADDRESS=127.0.0.1
OPEN_HARNESS_PUBLIC_URL=https://agents.example.com/api/local
OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1
```

The final setting allows remote requests through the dashboard proxy; Compose still requires browser pairing. Do not enable it until proxy authentication is working on every route, including `/api/local`. The client uses `Authorization: Bearer …` for the operator token, so an edge login must preserve that header and authenticate separately, for example through its own session cookie. HTTP Basic authentication on the same requests conflicts with this contract; do not exempt the API from edge authentication to work around it. A complete remote proxy configuration has not been accepted as part of the local-browser release.

Configure the proxy to preserve the dashboard Host and protocol, disable response buffering for run events, and allow long-running requests. Verify that an unauthenticated client cannot reach either the dashboard or API before enabling remote access. Mint the one-use code locally and open the paired link on your HTTPS dashboard origin.

After validating the proxy, rebuild the Compose service so it receives the environment values:

```bash
docker compose up -d --build
```

The coordinator runs as UID/GID `1000:1000`. Its privileged `docker` sidecar listens only on a private Unix socket volume; it has no TCP listener. The coordinator and sidecar use separate networks. Compose pairing also protects the operator API on platforms that route published host ports back to the dashboard. Never mount the control socket into an agent or connect the dashboard to the runtime network.

## Selected host folders

No host folders are exported by default. Copy `compose.host-folders.example.yaml`, replace its example source with an existing physical folder, and pass the edited file explicitly with `docker compose -f compose.yaml -f <your-override.yaml>` for every lifecycle command. Both outer services must mount the same folder at the same `/host-folders/<name>` path with the same read-only setting. Stop the stack before changing these mounts. Grant only an exact exported mount root; to share a subfolder, export it separately in both services first. Then grant that exported path to a specific agent in **Agent settings → Computer → Selected folders**. The UI cannot grant paths outside the exports or make a read-only export writable. On Docker Desktop, grant Docker access to only the physical folders you select.

## Update

Back up first and stop the stack. For an extracted source archive, extract the new source
release into a separate folder, retain your Compose project name, `.env` and explicit folder
override choices, then run its launcher with `--build` and the same override options. Keep
the previous release folder and backup for rollback. No Git installation is needed.

For an actual Git checkout, update and rebuild from that checkout:

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Database migrations run when the coordinator starts. Existing SQLite state, credentials, profiles, and the private container engine remain in named volumes.

The current source requires runtime contract 7. It refreshes the runtime base and dependency packages, keeps confirmed desktop initialization for selected-folder startup, and enables the private desktop's accessibility bus before applications launch, including browsers opened before the first computer-control call. If Readiness reports **Update agent runtime**, run runtime setup from the dashboard before starting agents. Rebuilding the coordinator alone does not rebuild the image inside the private engine. A policy-only patch cannot upgrade an older full runtime.

To roll back, stop the stack and restore the backup taken before the update into empty volumes, then start the previous release. Do not run older code against a state volume that has already been opened by a newer release.

### Existing root-owned data volumes

Older builds ran the coordinator as root. The new entrypoint initializes an empty volume automatically, but refuses to change ownership of existing data. If startup reports that `/data` must belong to UID/GID 1000, stop the stack and take the backup below first. Then migrate only the application data volume:

```bash
docker compose down
docker run --rm -v open-harness_harness-data:/data alpine chown -R 1000:1000 /data
docker compose up -d --build
```

These examples use the default Compose project name `open-harness`; substitute your project's actual volume names if you changed it. Do not change ownership of the engine's `harness-docker` volume.

## Backup and restore

Back up application data with **all writers stopped**. The archive includes SQLite, operator and model credentials, profiles, private/shared files, memories, skills, and history; protect it like a password vault. Keep backup files outside folders granted to agents. Selected host folders are not inside this volume and need their own backup.

Use the same Compose project and override options as your launcher. These examples assume the default project `open-harness`; verify the actual volume with `docker volume inspect open-harness_harness-data` before continuing. Capture the coordinator image before stopping the stack. The helper writes the archive directly, avoiding PowerShell's binary redirection behavior.

Bash (Linux/macOS), from a private backup directory:

```bash
# Run these first from your release directory.
coordinator_image=$(docker compose images -q open-harness)
docker compose down
# Then change to a private backup directory before running the helper.
docker run --rm --user 0 --entrypoint sh \
  --mount type=volume,source=open-harness_harness-data,target=/source,readonly \
  --mount "type=bind,source=$PWD,target=/backup" \
  "$coordinator_image" -c 'umask 077; tar -czpf /backup/open-harness-data.tgz -C /source .'
# Return to the release directory; restart using the same override options.
docker compose up -d
```

PowerShell, from your release directory (replace the backup path with an existing private directory):

```powershell
$coordinatorImage = docker compose images -q open-harness
docker compose down
$backupDirectory = 'C:\Users\YOUR_NAME\Open Harness Backups'
docker run --rm --user 0 --entrypoint sh --mount type=volume,source=open-harness_harness-data,target=/source,readonly --mount "type=bind,source=$backupDirectory,target=/backup" $coordinatorImage -c 'umask 077; tar -czpf /backup/open-harness-data.tgz -C /source .'
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; do not replace an earlier backup.' }
docker compose up -d
```

Use a new archive name for each backup. Check the helper's exit status and list the archive contents before relying on it. The example filename is for one backup only. File permission mapping on Docker Desktop depends on the host; protect the backup directory with your operating system's access controls.

Restore into a **new, empty application volume**, while both old and replacement stacks are stopped. Never merge a backup into existing application data. For example, choose the unused Compose project `open-harness-restore`, verify `docker volume inspect open-harness-restore_harness-data` reports that it does not exist, then create it. Stop if it already exists. Use the coordinator image from the release that created the backup.

```bash
docker volume create open-harness-restore_harness-data
docker run --rm --user 0 --entrypoint tar \
  --mount type=volume,source=open-harness-restore_harness-data,target=/target \
  --mount "type=bind,source=$PWD,target=/backup,readonly" \
  "$coordinator_image" -xzpf /backup/open-harness-data.tgz -C /target
# Return to the matching release directory and include your explicit overrides.
docker compose -p open-harness-restore up -d
```

On PowerShell, run the same `docker volume create` command, then use `$coordinatorImage` and `--mount "type=bind,source=$backupDirectory,target=/backup,readonly"` in a single-line `docker run` command. There is no shell redirection. Require a zero exit status before starting the replacement stack.

The private engine uses a new cache in the replacement project; run **Prepare agent runtime** to download the pinned image (or rebuild it for a source installation). Its old cache does not need to be copied across computers or architectures. Verify credentials, agent files, profiles, conversations, tasks, memory, and skills, then run a small agent task before retiring the original installation. Keep the original stopped volumes and backup until that verification succeeds.

Restore a pre-upgrade backup with the corresponding older release for rollback. Do not open a migrated database with older code. A clean restore cycle is exercised by `tests/compose-smoke.mjs`; platform-specific acceptance is recorded separately in `runtime/VERIFICATION.md`.
