<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vigilbase-logo-dark.png">
    <img alt="Vigilbase" src=".github/assets/vigilbase-logo-light.png" width="220">
  </picture>
</p>

<h1 align="center">HubSpot MCP Proxy for Cloudflare</h1>

<p align="center">
  A Cloudflare Worker that bridges the <strong>Cloudflare MCP Server Portal</strong> (and any other MCP client that relies on Dynamic Client Registration) to <strong>HubSpot's hosted MCP server</strong> at <code>mcp.hubspot.com</code>.
</p>

---

## Why this exists

HubSpot's MCP server publishes OAuth metadata but **omits the `registration_endpoint`** — every OAuth client must be pre-registered manually in the HubSpot developer dashboard. Cloudflare's MCP Server Portal (and most MCP clients) expects [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591), so the auto-connect flow can't complete.

This Worker plays both sides of the OAuth flow:

- **OAuth 2.1 + DCR authorization server** facing the portal.
- **OAuth 2.0 client** facing HubSpot, using one pre-registered HubSpot app whose credentials live as Worker secrets.

```
[Cloudflare MCP Portal] ──DCR + OAuth──▶ [this Worker] ──HubSpot OAuth──▶ mcp.hubspot.com
```

It also proxies the MCP transport itself, swapping bearer tokens transparently and refreshing HubSpot tokens on 401.

## Prerequisites

- A Cloudflare account with Workers enabled.
- A HubSpot developer account with an **MCP-type app** created (see step 1 below).
- [Wrangler v4+](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed locally.
- Node 18+ (for the dev dependencies).

## Setup

### 1. Create a HubSpot MCP app

In the [HubSpot developer dashboard](https://developers.hubspot.com/), create a new **MCP app** and grant it the scopes your MCP tools will need (CRM reads, etc.). Record the **Client ID** and **Client Secret** — you'll plug them into Cloudflare in step 4.

You'll also need to whitelist the Worker's callback URL as a redirect URI on the HubSpot app:

```
https://<your-worker-hostname>/oauth/callback
```

If you're deploying to `*.workers.dev` first, deploy once (step 3) to learn the assigned hostname, then come back and add the redirect URI to HubSpot. If you're using a custom domain, you already know the hostname.

### 2. Configure Wrangler

Clone the repo and create the two required KV namespaces:

```sh
git clone https://github.com/vigilbase/hubspot-mcp.git
cd hubspot-mcp
npm install

wrangler kv namespace create OAUTH_STATE
wrangler kv namespace create SESSIONS
```

Edit `wrangler.toml` and paste each returned `id` into the matching `[[kv_namespaces]]` block. Replace `REPLACE_WITH_OAUTH_STATE_KV_ID` / `REPLACE_WITH_SESSIONS_KV_ID`.

If you want a custom domain (e.g. `hubspot-mcp.example.com`), set `workers_dev = false` and uncomment the `routes` block. The zone must already exist in the same Cloudflare account.

### 3. Deploy

```sh
wrangler deploy
```

Wrangler will print the Worker's URL. With `workers_dev = true` it'll be something like `https://hubspot-mcp-proxy.<your-subdomain>.workers.dev`. With a custom domain it'll be that hostname.

### 4. Set the HubSpot OAuth secrets

```sh
printf '%s' '<your_hubspot_client_id>' | wrangler secret put HUBSPOT_CLIENT_ID
printf '%s' '<your_hubspot_client_secret>' | wrangler secret put HUBSPOT_CLIENT_SECRET
```

These are stored as encrypted Worker secrets — never committed to the repo, never visible at runtime to anyone with read access to your dash.

### 5. Whitelist the redirect URI in HubSpot

Back in the HubSpot app's OAuth settings, add the redirect URI:

```
https://<the-worker-hostname-from-step-3>/oauth/callback
```

HubSpot does exact-match comparison — no trailing slash, no extra path.

### 6. Add the MCP server to the Cloudflare MCP Portal

In the Cloudflare dashboard → **Zero Trust** → **Access controls** → **AI controls** → **MCP server portals** → **Add MCP server**, point it at:

```
https://<the-worker-hostname-from-step-3>/mcp
```

The portal will discover the OAuth metadata, register itself via DCR, redirect you to HubSpot for consent, and (after you authorize) initialize an MCP session. If you see "Server authentication failed" or "Failed to fetch", `wrangler tail` from the project directory to see what HubSpot is returning to the Worker.

## How it works

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata for the MCP transport. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata advertising DCR + PKCE. |
| `POST /oauth/register` | RFC 7591 DCR — accepts any portal-side `redirect_uris` and mints a `client_id`. No client secrets issued (public client + PKCE). |
| `GET /oauth/authorize` | Validates the registered client, generates an upstream PKCE pair, redirects the browser to HubSpot's authorize endpoint. |
| `GET /oauth/callback` | Receives HubSpot's authorization code, exchanges it for HubSpot tokens, mints a short-lived authorization code for the portal, redirects back. |
| `POST /oauth/token` | Verifies the portal's PKCE, exchanges the code for an opaque access token whose KV-backed mapping points at the HubSpot tokens. Also handles `refresh_token` grants. |
| `POST /mcp` | Requires a Bearer token, looks up the corresponding HubSpot token (refreshing if near expiry or on 401), proxies the MCP request body to `mcp.hubspot.com` and streams the response back. |

CORS is permissive (echoes the request `Origin`) because browser-based MCP clients like the Cloudflare portal would otherwise be blocked by the same-origin policy.

## Teardown

```sh
wrangler delete
wrangler kv namespace delete --namespace-id <OAUTH_STATE_KV_ID>
wrangler kv namespace delete --namespace-id <SESSIONS_KV_ID>
```

Then remove the HubSpot OAuth app from the HubSpot developer dashboard and the MCP server entry from the Cloudflare MCP portal.

## License

MIT — see [LICENSE](./LICENSE).

## About

Built by [Vigilbase](https://vigilbase.com) — a Cloudflare partner focused on Zero Trust, MCP gateways, and modern security infrastructure.
