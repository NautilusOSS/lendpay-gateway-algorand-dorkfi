# Install DorkFi gateway on Ubuntu as a systemd service

This guide runs the gateway as an unprivileged user under **systemd**, with logs in the journal and automatic restarts on failure.

**Prerequisites:** Ubuntu 22.04 or 24.04 (or similar), sudo, outbound HTTPS for RPC and Algod.

## 1. Install Node.js 20+

The app requires **Node.js 20 or newer** (see `engines` in `package.json`). Pick one approach:

**NodeSource (common on servers):**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should show v20.x or higher
```

**Or** use another supported install (fnm, nvm, official tarball). For systemd, use a **stable absolute path** to `node` (for example `/usr/bin/node` from the NodeSource package). If you use nvm, point `ExecStart` at that binary explicitly.

## 2. Create a system user and app directory

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin dorkfi-gateway
sudo mkdir -p /opt/dorkfi-gateway
sudo chown dorkfi-gateway:dorkfi-gateway /opt/dorkfi-gateway
```

## 3. Deploy the application

Copy or clone the repository into `/opt/dorkfi-gateway` so that `package.json` and `package-lock.json` live at `/opt/dorkfi-gateway/package.json`.

Example with git:

```bash
sudo -u dorkfi-gateway git clone https://github.com/YOUR_ORG/dorkfi-gateway.git /opt/dorkfi-gateway
```

Or rsync/scp your build tree into the same path, then:

```bash
cd /opt/dorkfi-gateway
sudo -u dorkfi-gateway cp .env.example .env
sudo -u dorkfi-gateway nano .env   # set real values; never commit this file
sudo chmod 600 /opt/dorkfi-gateway/.env
sudo -u dorkfi-gateway npm ci --omit=dev
sudo -u dorkfi-gateway npm run build
```

Confirm `dist/server.js` exists. Environment variables are documented in [.env.example](../.env.example) and [README.md](../README.md).

## 4. systemd unit

Create `/etc/systemd/system/dorkfi-gateway.service`:

```ini
[Unit]
Description=DorkFi repay gateway (Express)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dorkfi-gateway
Group=dorkfi-gateway
WorkingDirectory=/opt/dorkfi-gateway

# Loads KEY=value lines (same style as .env). Keep file mode 0600.
EnvironmentFile=/opt/dorkfi-gateway/.env

ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5

# Optional hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

If `node` is not at `/usr/bin/node`, run `which node` as the deploy user and put that path in `ExecStart`.

**Note:** systemd `EnvironmentFile` does not run shell; use plain `KEY=value` lines. Avoid `export` prefixes in `.env` if you use this file for both manual runs and systemd.

## 5. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dorkfi-gateway.service
sudo systemctl status dorkfi-gateway.service
```

Health check (default port from `PORT` in `.env`, else 3000):

```bash
curl -sS http://127.0.0.1:3000/health
```

## 6. Logs and operations

```bash
sudo journalctl -u dorkfi-gateway.service -f
sudo systemctl restart dorkfi-gateway.service
```

After changing `.env` or upgrading code:

```bash
cd /opt/dorkfi-gateway
sudo -u dorkfi-gateway npm ci --omit=dev && sudo -u dorkfi-gateway npm run build
sudo systemctl restart dorkfi-gateway.service
```

## 7. Optional: reverse proxy and TLS

The server listens on `PORT` (default `3000`) on all interfaces. For HTTPS and rate limiting, put **nginx** or **Caddy** in front and proxy to `http://127.0.0.1:3000`. Restrict inbound firewall rules so only the proxy can reach that port.

## Troubleshooting

| Symptom | Check |
|--------|--------|
| `status=203/EXEC` | Wrong `ExecStart` path to `node` or missing `dist/server.js` (run `npm run build`). |
| Service exits immediately | `journalctl -u dorkfi-gateway -n 50` for stack traces; verify `.env` and RPC URLs. |
| Permission errors on `.env` | `chown dorkfi-gateway:dorkfi-gateway /opt/dorkfi-gateway/.env` and `chmod 600`. |

For webhook API keys and headers, see [docs/index.md](index.md).
