# Vigilbase HubSpot MCP Proxy — teardown

Throwaway demo wiring. Everything below should be removable in under 5 minutes.

## What was created

Cloudflare account: **Vigilbase** (`fece050ea6eeb7ae9940b6fd6998484d`)

| Resource | Identifier |
|---|---|
| Worker | `vigilbase-hubspot-mcp` |
| Custom domain | `hubspot-mcp.vigilbase.dev` (zone `vigilbase.dev`) |
| KV namespace `OAUTH_STATE` | `8b4b445ba2af404cb582a186f4a1a860` |
| KV namespace `SESSIONS` | `98adeda01e234744b8549913f07e5bf0` |
| Worker secret | `HUBSPOT_CLIENT_ID` |
| Worker secret | `HUBSPOT_CLIENT_SECRET` |

The HubSpot side has a single OAuth app (created manually in the HubSpot developer
dashboard) with the redirect URI `https://hubspot-mcp.vigilbase.dev/oauth/callback`.

## Teardown commands

Run from this directory.

```sh
# 1. Delete the Worker (also removes the custom domain binding + secrets).
wrangler delete

# 2. Delete the KV namespaces.
wrangler kv namespace delete --namespace-id 8b4b445ba2af404cb582a186f4a1a860
wrangler kv namespace delete --namespace-id 98adeda01e234744b8549913f07e5bf0

# 3. (Optional) Remove the HubSpot OAuth app from
#    https://developers.hubspot.com/ → Apps → vigilbase-hubspot-mcp.

# 4. (Optional) Remove the MCP server entry from
#    Cloudflare One → Access controls → AI controls → MCP server portals.
```

The custom domain DNS record is auto-removed by `wrangler delete`. If you instead
manually drop the route, also delete the `hubspot-mcp` CNAME in the
`vigilbase.dev` zone.

## Reversibility notes

- Deleting the Worker invalidates all live MCP sessions (portal users will need
  to re-authorize). Expected for teardown.
- KV deletion is permanent — but all data is short-lived OAuth state and bearer
  tokens; no business data is ever stored.
- The HubSpot client_id is account-scoped, not user-scoped. Revoking it from
  the HubSpot app dashboard invalidates all tokens minted via that app.
