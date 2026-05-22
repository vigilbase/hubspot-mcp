# vigilbase-hubspot-mcp

Cloudflare Worker that bridges the **Cloudflare MCP Server Portal** to
**HubSpot's MCP server** (`https://mcp.hubspot.com/mcp`).

## Why this exists

The Cloudflare MCP Server Portal expects upstream MCP servers to support
[Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591).
HubSpot's MCP server publishes OAuth metadata at
`https://mcp.hubspot.com/.well-known/oauth-authorization-server` but **omits
`registration_endpoint`** — every OAuth client must be pre-registered manually
in the HubSpot developer dashboard.

This Worker plays both sides:

- **OAuth 2.1 authorization server** (with DCR + PKCE) facing the portal.
- **OAuth 2.0 client** facing HubSpot, using a single pre-registered HubSpot
  app whose `client_id`/`client_secret` live as Worker secrets.

It also proxies MCP requests at `/mcp` to HubSpot, swapping bearer tokens.

```
[Cloudflare MCP Portal] ──DCR + OAuth──▶ [this Worker] ──HubSpot OAuth──▶ mcp.hubspot.com/mcp
```

## Public endpoint

| Use | URL |
|---|---|
| MCP endpoint (give this to the portal) | `https://hubspot-mcp.vigilbase.dev/mcp` |
| HubSpot OAuth redirect URI (whitelist in the HubSpot app) | `https://hubspot-mcp.vigilbase.dev/oauth/callback` |
| Discovery | `https://hubspot-mcp.vigilbase.dev/.well-known/oauth-authorization-server` |

## Local dev

```sh
npm install
# Set the two secrets in .dev.vars (gitignored):
#   HUBSPOT_CLIENT_ID=...
#   HUBSPOT_CLIENT_SECRET=...
wrangler dev
```

## Deploy

```sh
wrangler deploy
printf '%s' '<client_id>' | wrangler secret put HUBSPOT_CLIENT_ID
printf '%s' '<client_secret>' | wrangler secret put HUBSPOT_CLIENT_SECRET
```

## Teardown

See [TEARDOWN.md](./TEARDOWN.md).
