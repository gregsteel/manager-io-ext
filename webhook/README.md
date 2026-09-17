# Webhook auto-deploy

Push to `main` on GitHub → this container verifies the request, then runs
`git pull && ./deploy.sh` against the checkout at the repo root.

Runs [`lwlook/webhook`](https://hub.docker.com/r/lwlook/webhook), a Docker
wrapper around [`adnanh/webhook`](https://github.com/adnanh/webhook/tree/master/docs).
Every request must pass **all three** checks in `hooks.json` before anything
executes:

- `X-GitHub-Event: push`
- payload `ref == refs/heads/main`
- a valid HMAC-SHA256 signature in `X-Hub-Signature-256`, checked against the
  secret in `hooks.json`

There are two ways to get GitHub's events to this container. Pick one.

- **A — `gh webhook forward`** (recommended for this repo): no public
  endpoint at all. Matches `compose.yaml`'s existing constraint that this
  stack owns no public TLS/hostname surface.
- **B — direct GitHub webhook through a reverse proxy**: only if you already
  have a proxy (e.g. `home-gateway`) fronting this host with a public
  hostname and are willing to expose the endpoint to GitHub's servers.

Both options enforce the same HMAC check — the difference is only in how
GitHub's event reaches the container.

## 1. Generate the secret (needed either way)

```sh
openssl rand -hex 32
```

Put the output in two places (they must match exactly):

```sh
cp hooks.json.example hooks.json
# edit hooks.json: replace REPLACE_ME_WITH_RANDOM_SECRET with the value above
chmod 600 hooks.json
```

`hooks.json` is gitignored — only `hooks.json.example` is tracked.

## 2. Deploy key (needed either way)

`origin` is an SSH remote, so the container needs its own read-only key to
`git pull`:

```sh
mkdir -p ../secrets/webhook-ssh
ssh-keygen -t ed25519 -N "" -f ../secrets/webhook-ssh/id_ed25519 -C "manager-io-ext-webhook-deploy"
ssh-keyscan github.com >> ../secrets/webhook-ssh/known_hosts
chmod 700 ../secrets/webhook-ssh
chmod 600 ../secrets/webhook-ssh/id_ed25519
```

Add `../secrets/webhook-ssh/id_ed25519.pub` to the GitHub repo as a
**read-only** Deploy Key: Settings → Deploy keys → Add deploy key.

## 3. Start the container

From the repo root:

```sh
./deploy.sh
```

This brings up the `webhook` service along with everything else. Confirm
it's listening:

```sh
docker compose logs webhook
curl -i http://127.0.0.1:9000/hooks/deploy-accounting   # expect 400 (no signature) — proves it's up
```

## Option A — `gh webhook forward` (no public exposure)

`compose.yaml` binds the webhook service to `127.0.0.1:9000` only. GitHub CLI's
`gh webhook forward` opens an authenticated tunnel from github.com to that
local port — nothing needs to be reachable from the internet.

```sh
gh auth login          # if not already authenticated on this host
gh extension install cli/gh-webhook
```

It needs to run continuously, so install it as a systemd unit rather than
running it in a foreground shell:

`/etc/systemd/system/gh-webhook-forward.service`:

```ini
[Unit]
Description=Forward GitHub webhook events to local deploy webhook
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=<deploy-user>
ExecStart=/usr/bin/gh webhook forward \
    --repo gregsteel/manager-io-ext \
    --events=push \
    --secret=<PASTE_SAME_SECRET_AS_hooks.json> \
    --url=http://127.0.0.1:9000/hooks/deploy-accounting
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gh-webhook-forward
sudo systemctl status gh-webhook-forward   # confirm it connected
```

`gh webhook forward` registers/manages the webhook on the GitHub repo itself
(you'll see it appear under Settings → Webhooks once it connects) — you
don't add it manually in the GitHub UI under this option.

Test end-to-end:

```sh
git commit --allow-empty -m "test webhook deploy" && git push
docker compose logs -f webhook   # watch for the deploy-accounting hook firing
```

## Option B — direct GitHub webhook via a reverse proxy

Use this only if a reverse proxy already terminates TLS for a public
hostname pointed at this host (e.g. `home-gateway`, per the note at the top
of `compose.yaml`). This exposes the endpoint to GitHub's webhook servers —
the HMAC check is then your *only* line of defense, since anyone on the
internet can send a request to it.

**1. Point the proxy at the container.** In `compose.yaml`, change the
`webhook` service's port binding from loopback-only to a normal published
port so the proxy container can reach it (mirrors how `manager`/`receipts`/
etc. are already published in this file):

```yaml
    ports:
      - "9000:9000"
```

Add an upstream/location on the proxy, e.g. for an nginx-style proxy
reaching this host via `host.docker.internal` (same pattern `home-gateway`
uses for this stack's other services):

```nginx
location /hooks/ {
    proxy_pass http://host.docker.internal:9000;
    proxy_set_header Host $host;
}
```

Pick a hostname/path you're comfortable exposing, e.g.
`https://deploy.example.com/hooks/deploy-accounting`.

**2. Add the webhook in the GitHub UI**: repo → Settings → Webhooks → Add
webhook.

| Field | Value |
|---|---|
| Payload URL | `https://deploy.example.com/hooks/deploy-accounting` |
| Content type | `application/json` |
| Secret | the same value you put in `hooks.json` |
| Which events | "Just the push event" |
| Active | checked |

GitHub will send a test ping on save. Check delivery under the webhook's
"Recent Deliveries" tab, and `docker compose logs webhook` on the host, to
confirm it's reaching the container and passing signature verification.

**3. Restart to pick up the port change:**

```sh
./deploy.sh
```

### Hardening if you go with Option B

- Consider allowlisting
  [GitHub's published webhook IP ranges](https://api.github.com/meta) (the
  `hooks` key) at the proxy or firewall, in addition to the HMAC check.
- Keep `docker.sock` in mind: this container can control the whole host's
  Docker daemon. A signature bypass here is not a small blast radius.
- Rotate the secret (regenerate, update both `hooks.json` and the GitHub
  webhook's secret field, restart) periodically or if you ever suspect it
  leaked.

## Manually testing signature verification

Compute a valid signature for an arbitrary payload and confirm the hook
accepts it:

```sh
SECRET=$(grep -o '"secret": *"[^"]*"' hooks.json | cut -d'"' -f4)
BODY='{"ref":"refs/heads/main"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)"

curl -i http://127.0.0.1:9000/hooks/deploy-accounting \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

A wrong secret or missing header should get rejected (HTTP 400); this exact
request should trigger a real deploy, so only run it when you mean to.

## Troubleshooting

- **`docker compose logs webhook` shows `git: command not found`** — the
  `lwlook/webhook` base image doesn't include git. You'll need a custom
  image (`FROM lwlook/webhook` + install git) or run the webhook receiver
  natively on the host instead of in Docker.
- **`fatal: detected dubious ownership in repository`** — `deploy-hook.sh`
  already runs `git config --global --add safe.directory /repo` for this;
  if it still happens, check the bind-mounted repo's ownership on the host.
- **Signature never matches** — the secret in `hooks.json` and the one given
  to `gh webhook forward --secret=` (or the GitHub webhook's Secret field)
  must be byte-for-byte identical, including no trailing newline.
