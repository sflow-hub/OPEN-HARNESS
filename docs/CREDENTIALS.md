# Credentials and API access

Open **Credentials** in workspace navigation to save accounts under names such as
“Work OpenAI” or “Production service.” Search, filter by type, sort, and see which
agents use each account. **Add credential** starts with a service: a model provider
saves a single key, **Codex (ChatGPT OAuth)** signs in with a ChatGPT account (see the
README), and **Generic secret** opens the typed editor for every type below.
**Create credential…** in a model or connection selector opens the same typed editor
and selects the saved account without discarding other changes in that screen.

Google Workspace and GitHub accounts are not credentials here: connect them as
workspace connections, which keep their tokens in a separate coordinator vault and
route actions through review.

Model selectors load available models from the selected provider, key, and endpoint.
Use the search field to filter the dropdown, or choose **Custom model ID…** for an
exact ID. A credential's default model seeds a selection; changing that default
does not change models already chosen by agents. Connection tests run only when
requested. Generic API tests require a configured test URL and perform a GET.

## Credential types

| Type | Stored secrets | Configuration |
| --- | --- | --- |
| Model API key | API key | Provider, optional endpoint and default model |
| API key | Key | Header or query placement and parameter name |
| Bearer token | Token | Optional connection test URL |
| Basic authentication | Username and password | Optional connection test URL |
| Multiple headers | JSON object of header values | Optional connection test URL |
| OAuth2 | Client secret, access and refresh tokens | Grant, endpoints, client ID, authentication method, scopes, authorization parameters |

Secret fields are write-only. Editing shows which fields are saved, with empty
inputs; leaving them blank preserves the stored values. **Replace** changes secret
fields under the same immutable reference. Create another credential to change its
type. Deleting an account in use shows its references and offers reassignment or an
explicit forced deletion. Forced deletion can prevent subsequent API requests by
active runs; model and MCP processes retain values already delivered to them.

## Generic OAuth2

Register your own OAuth application with the service you want to use. Open Harness
supports authorization code with PKCE/S256 and client credentials. Supply HTTPS
endpoints, the app's client ID, optional client secret, scopes, and client
authentication method (`body`, `basic`, or `none`). Public PKCE clients use `none`.
Authorization parameters accept a JSON object such as
`{"access_type":"offline","prompt":"consent"}` and cannot override security fields.

Save an authorization-code credential, copy the **OAuth callback URL** shown in the
library, and register that exact redirect URI with the service before clicking
**Connect**. Allow the sign-in popup and complete authorization there. **Disconnect**
removes locally stored access and refresh tokens; provider-side revocation, if
needed, happens through that provider's account settings.

Native installations default to the loopback coordinator callback. Compose requires
`OPEN_HARNESS_OAUTH_CALLBACK_BASE_URL` even for a local browser: use
`http://localhost:3000/api/local` for the default local installation, or the actual
browser origin and port. For a hosted dashboard, use for example
`https://harness.example.com/api/local`. Set it in the coordinator's environment;
Compose forwards the variable from `.env`. Use a dashboard protected by the existing
HTTPS reverse proxy and browser pairing. Authorization callbacks alone accept a
short-lived, one-use OAuth state instead of the operator token. Restarting the
coordinator expires pending sign-in attempts.

Tokens refresh before tasks and authenticated API calls, with refresh requests
serialized per credential. Changing OAuth connection settings or client secrets
requires reconnection. A failed refresh reports **Reconnect required**.

## Agent tools and MCP connections

In **Agent settings → Tools & connections**, enable **Authenticated API request**
and add an API grant: select a credential, specify exact HTTPS origins without
paths, and select permitted methods. New grants start with GET. An agent calls
`api_request` with `credentialRef`, `url`, optional `method`, `query`, `headers`, and
`body`. The coordinator supplies authentication and returns status, content type,
and a redacted response body. Grants are captured when a task starts; editing a
profile applies to later tasks. API calls resolve the current saved credential.

Response masking removes literal, URL-encoded and JSON-escaped credential values
and Basic authentication encodings. It is best-effort: an endpoint can encode or
transform a secret in another way. Grant only endpoints you trust with the selected
credential, and review responses before sharing them.

Requests cannot replace authentication, follow redirects, reach metadata or
coordinator endpoints, or exceed a 30-second deadline or 1 MB response. Private
network destinations require an explicit grant. Mutating requests are not retried
automatically. Allowed methods authorize API actions as well as authentication;
grant only the methods the agent needs.

For MCP servers, **Add credential field** maps a selected secret field to the
server's required environment variable, such as `accessToken` → `ACCESS_TOKEN`.
Only mapped fields are delivered. OAuth client secrets and refresh tokens remain
with the coordinator. Legacy single-key `secretRef` connections remain supported.
OAuth access tokens passed through environment variables are fixed for that task;
if one expires during a long task, the MCP server reconnects on the next task.
Remote runner delivery remains encrypted to that runner's public key.

## Encrypted storage and backups

Desktop installations retain the OS vault. File fallback uses AES-256-GCM in
`secrets.json`, with a fresh nonce for each atomic, verified write. Existing
plaintext files migrate without changing credential references or the control
token. The file and generated `secrets.json.key` have mode `0600` where supported.
The generated key lives beside the encrypted file for unattended local startup;
possession of both files permits decryption.

Optionally supply a base64-encoded 32-byte `OPEN_HARNESS_ENCRYPTION_KEY` through
your deployment's secret configuration instead of the generated key file. The
same original key is required after restart and restore. Changing the variable
does not rotate an existing store. Missing/wrong keys and damaged encrypted data
stop startup without resetting credentials or minting a new control token.

Stop all writers before backup. Back up the complete state volume and preserve
the original encryption key securely, ideally in a separate backup location.
Existing full-volume backups include the generated key file; protect those
archives as a credential vault. For an environment-supplied key, back it up through
your secret manager as well as backing up application data. Diagnostics and normal
browser exports include neither secret values nor encryption keys. An OS-vault
installation also needs the original vault entry or separately re-entered keys.
