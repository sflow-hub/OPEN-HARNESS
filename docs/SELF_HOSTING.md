# Self-hosting operations

Open Harness is designed for one trusted operator. Anyone who reaches the dashboard has operator-level access to agents, files, and saved model credentials. Keep the default loopback binding unless an authenticated HTTPS reverse proxy protects every request.

Allow at least 20 GB of free disk before the first agent-runtime build. Open Harness does not automatically prune user history during the beta, so monitor Compose volume sizes and `docker system df`. Model-provider requests are sent to the provider you configure and may incur charges; Open Harness itself sends no product telemetry.

## Start and verify

From the source release directory:

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

The health endpoint returns only `{"ok":true}`. It reports that the dashboard can reach the coordinator; model credentials and the Hermes execution runtime are checked separately in the first-run guide. Follow logs with `docker compose logs -f open-harness` and download a credential-free diagnostic bundle from **Workspace settings → Download diagnostics**.

## Authenticated HTTPS access

Keep port 3000 on loopback when the reverse proxy runs on the same server. Set these values in `.env`:

```dotenv
OPEN_HARNESS_LISTEN_ADDRESS=127.0.0.1
OPEN_HARNESS_PUBLIC_URL=https://agents.example.com/api/local
OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1
```

The final setting allows the dashboard to return its operator token through the proxy. Do not enable it until authentication is working. This Nginx example uses an `htpasswd` file and disables response buffering so run events arrive promptly:

```nginx
server {
    listen 443 ssl http2;
    server_name agents.example.com;

    ssl_certificate /etc/letsencrypt/live/agents.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agents.example.com/privkey.pem;

    auth_basic "Open Harness";
    auth_basic_user_file /etc/nginx/open-harness.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Reload Nginx, then rebuild the Compose service so it receives the environment values:

```bash
docker compose up -d --build
```

Never expose the Compose `docker` service or its port. Its unauthenticated Docker API is intentionally reachable only inside the private Compose network.

## Update

Back up first, update the source release, then rebuild:

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Database migrations run when the coordinator starts. Existing SQLite state, credentials, profiles, and the private container engine remain in named volumes.

To roll back, stop the stack and restore the backup taken before the update into empty volumes, then start the previous release. Do not run older code against a state volume that has already been opened by a newer release.

## Backup and restore

Stop the stack before copying its volumes so SQLite and Docker data are consistent:

```bash
docker compose down
docker run --rm -v open-harness_harness-data:/source:ro -v "$PWD":/backup alpine tar -czf /backup/open-harness-data.tgz -C /source .
docker run --rm -v open-harness_harness-docker:/source:ro -v "$PWD":/backup alpine tar -czf /backup/open-harness-docker.tgz -C /source .
docker compose up -d
```

The data archive contains the database, credentials, agent profiles, and working files. Protect it like a password vault. The Docker archive avoids rebuilding the pinned Hermes runtime but can be omitted when storage is limited.

Restore only into a stopped stack with empty destination volumes:

```bash
docker compose down
docker volume create open-harness_harness-data
docker volume create open-harness_harness-docker
docker run --rm -v open-harness_harness-data:/target -v "$PWD":/backup alpine tar -xzf /backup/open-harness-data.tgz -C /target
docker run --rm -v open-harness_harness-docker:/target -v "$PWD":/backup alpine tar -xzf /backup/open-harness-docker.tgz -C /target
docker compose up -d --build
```

If the destination volumes already contain data, move or archive them first rather than merging two installations.
