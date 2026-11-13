# Private always-on server

This preset runs Open Harness on a Linux server and reaches it from your phone through
Tailscale Serve. The dashboard stays on `127.0.0.1:3000`; the coordinator and private
container engine retain their existing boundaries. Tailnet access controls authenticate
the network connection, HTTPS protects it, and Open Harness still requires its own
one-use browser pairing. There is no public dashboard port or Funnel configuration.

You need an always-on Linux host, Docker with Compose **2.24.4 or later**, an Open Harness
source checkout, and Tailscale installed and signed in on both the host and phone. Use
your tailnet access policy to restrict this server to the operator's devices. Follow the
existing [disk, backup, runtime preparation, and restore guidance](../../docs/SELF_HOSTING.md).
The preset uses the Compose project named `open-harness`. On a fresh host it creates new
volumes; if that project already exists, it updates those services and reuses their data.
Back up an existing project before applying the preset. It does not copy a separate local
source workspace or move data from another computer.

From the checkout on the server, use its exact `Self.DNSName` from `tailscale status --json`
(without the trailing dot):

```bash
bash deploy/private-server/start.sh your-server.your-tailnet.ts.net
```

The script validates the host name and Compose version, refuses an existing Serve
configuration or settings file, writes a private `.env.private-server`, starts Compose,
enables private HTTPS, and prints a five-minute one-use pairing link. It never installs
Tailscale, signs in for you, provisions a cloud host, or enables public Funnel access.
If Tailscale requires HTTPS to be enabled for the tailnet, follow its displayed setup
link. Re-running the entire script is not needed after that step.

Open the connection link on a device connected to your tailnet. Finish the in-app guide
to prepare Hermes and configure a model. **Workspace settings → Connect your phone**
creates another one-use link for an already paired operator. On iPhone, add the HTTPS
dashboard to the Home Screen before enabling notifications. Send a test notification
and check that it arrives; browser permission alone does not establish delivery.

The model service may still require an API key, and your hosting/model providers may
charge for use. Existing pinned image security/acceptance requirements still apply;
this preset does not certify an unverified image for release.

## Existing Serve configuration and recovery

The script deliberately refuses to replace another application's Serve configuration.
Use another dedicated Tailscale host, or review your existing configuration and apply an
appropriate separate HTTPS port manually. If using a separate port, include it in
`OPEN_HARNESS_REMOTE_ORIGIN` and use the same port in the Serve command.

If setup stopped after creating `.env.private-server`, inspect the error and continue
with these commands instead of deleting running services or volumes:

```bash
docker compose --env-file .env.private-server -f compose.yaml -f deploy/private-server/compose.yaml up -d --build --wait
tailscale serve --bg --https=443 http://127.0.0.1:3000
docker compose --env-file .env.private-server -f compose.yaml -f deploy/private-server/compose.yaml exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs
```

The final command returns a fresh `code`. Open `https://your-server.your-tailnet.ts.net/#pair=<code>`.
Keep the code out of query strings, logs, and shared documents. Tailscale Serve's `--bg`
configuration persists across restarts; Docker and Tailscale must themselves start on boot.
Compose uses `unless-stopped`, so services you explicitly stopped need to be started again.
After a host restart, check `docker compose ... ps`, `tailscale serve status`, and a
small task from your phone. Closing the browser is supported; turning off the server
stops work. A recovered schedule dispatches one overdue occurrence, not all missed runs.

For normal stop/start, use the same `--env-file` and both `-f` options with `stop` or
`up -d`. Do not use `down -v` unless intentionally destroying workspace data. A local
source installation uses `npm run harness:install-service` and `npm run harness:start`
instead; this preset does not change that service.

Tailscale Serve forwards the existing `Authorization: Bearer` header. Do not add HTTP
Basic authentication on these requests: it competes for the same header. A different
public reverse proxy must authenticate every route with a separate session mechanism
and preserve the operator header; that deployment requires its own verification.
External webhook senders and remote runners also need tailnet access to this private preset.

References: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[Serve CLI and background persistence](https://tailscale.com/docs/reference/tailscale-cli/serve),
[Compose port replacement](https://docs.docker.com/reference/compose-file/merge/).

Validation for this change covers local configuration and command fixtures. A real
cloud deployment, certificate issuance, phone login, and reboot recovery have not been
executed as part of the automated tests.
