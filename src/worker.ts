/**
 * Vigilbase HubSpot MCP Proxy
 *
 * Sits between Cloudflare's MCP Server Portal and https://mcp.hubspot.com so that
 * the portal — which expects Dynamic Client Registration — can talk to HubSpot,
 * which does NOT advertise a `registration_endpoint`. We act as:
 *
 *   - An OAuth 2.1 + DCR authorization server to the portal (RFC 7591, RFC 8414).
 *   - A static-client OAuth client to HubSpot, using a single pre-registered
 *     HubSpot app whose credentials are stored as Worker secrets.
 *
 * Token strategy: we issue our own opaque access tokens to the portal and keep a
 * server-side mapping to the real HubSpot tokens in KV. The portal never sees
 * HubSpot tokens; HubSpot never sees the portal's client_id. We refresh upstream
 * tokens on 401 from HubSpot, transparently.
 */

export interface Env {
  OAUTH_STATE: KVNamespace;
  SESSIONS: KVNamespace;
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  HUBSPOT_AUTHORIZE_URL: string;
  HUBSPOT_TOKEN_URL: string;
  HUBSPOT_MCP_URL: string;
  HUBSPOT_SCOPES: string;
}

type RegisteredClient = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
};

type PendingAuth = {
  registered_client_id: string;
  portal_redirect_uri: string;
  portal_state: string | null;
  portal_code_challenge: string | null;
  portal_code_challenge_method: string | null;
  upstream_verifier: string;
};

type IssuedCode = {
  registered_client_id: string;
  portal_redirect_uri: string;
  portal_code_challenge: string | null;
  portal_code_challenge_method: string | null;
  hubspot_access_token: string;
  hubspot_refresh_token: string | null;
  hubspot_expires_at: number;
};

type SessionTokens = {
  hubspot_access_token: string;
  hubspot_refresh_token: string | null;
  hubspot_expires_at: number;
};

const TEN_MIN = 60 * 10;
const ONE_HOUR = 60 * 60;
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Browser-side MCP clients (incl. the Cloudflare MCP Portal) call discovery
    // and DCR endpoints via fetch(); without CORS the browser blocks them with
    // an opaque "Failed to fetch". Answer preflight unconditionally and decorate
    // every response on the way out.
    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }

    let res: Response;
    try {
      switch (url.pathname) {
        case "/":
          res = text("vigilbase-hubspot-mcp proxy — see /.well-known/oauth-authorization-server");
          break;
        case "/.well-known/oauth-protected-resource":
          res = json(protectedResourceMetadata(url));
          break;
        case "/.well-known/oauth-authorization-server":
          res = json(authServerMetadata(url));
          break;
        case "/oauth/register":
          res = await handleRegister(req, env);
          break;
        case "/oauth/authorize":
          res = await handleAuthorize(req, env, url);
          break;
        case "/oauth/callback":
          res = await handleCallback(req, env, url);
          break;
        case "/oauth/token":
          res = await handleToken(req, env, url);
          break;
        case "/mcp":
          res = await handleMcp(req, env);
          break;
        default:
          res = new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("worker error:", msg);
      res = json({ error: "server_error", error_description: msg }, 500);
    }
    return withCors(req, res);
  },
};

function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  const origin = req.headers.get("origin") ?? "*";
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  headers.set("access-control-expose-headers", "www-authenticate, mcp-session-id");
  headers.set("access-control-max-age", "86400");
  headers.append("vary", "origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ─────────────────────────── discovery documents ───────────────────────────

function protectedResourceMetadata(url: URL) {
  return {
    resource: origin(url),
    authorization_servers: [origin(url)],
    scopes_supported: ["hubspot"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/vigilbase/hubspot-mcp#readme",
  };
}

function authServerMetadata(url: URL) {
  const base = origin(url);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["hubspot"],
  };
}

// ───────────────────────── dynamic client registration ─────────────────────

async function handleRegister(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_client_metadata" }, 400);
  }
  const redirect_uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u: unknown) => typeof u === "string") : [];
  if (redirect_uris.length === 0) {
    return json({ error: "invalid_redirect_uri", error_description: "at least one redirect_uri required" }, 400);
  }
  const client_id = `vbhs-${randomId(24)}`;
  const record: RegisteredClient = {
    client_id,
    redirect_uris,
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    created_at: Date.now(),
  };
  await env.OAUTH_STATE.put(`client:${client_id}`, JSON.stringify(record), { expirationTtl: THIRTY_DAYS });
  return json(
    {
      client_id,
      redirect_uris,
      client_name: record.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

// ──────────────────────────── authorize endpoint ───────────────────────────

async function handleAuthorize(_req: Request, env: Env, url: URL): Promise<Response> {
  const params = url.searchParams;
  const client_id = params.get("client_id") ?? "";
  const redirect_uri = params.get("redirect_uri") ?? "";
  const response_type = params.get("response_type") ?? "";
  const state = params.get("state");
  const code_challenge = params.get("code_challenge");
  const code_challenge_method = params.get("code_challenge_method");

  if (response_type !== "code") {
    return json({ error: "unsupported_response_type" }, 400);
  }
  const clientRaw = await env.OAUTH_STATE.get(`client:${client_id}`);
  if (!clientRaw) {
    return json({ error: "invalid_client" }, 400);
  }
  const client: RegisteredClient = JSON.parse(clientRaw);
  if (!client.redirect_uris.includes(redirect_uri)) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }

  const upstream_verifier = randomId(64);
  const upstream_challenge = await s256(upstream_verifier);
  const callbackState = randomId(32);

  const pending: PendingAuth = {
    registered_client_id: client_id,
    portal_redirect_uri: redirect_uri,
    portal_state: state,
    portal_code_challenge: code_challenge,
    portal_code_challenge_method: code_challenge_method,
    upstream_verifier,
  };
  await env.OAUTH_STATE.put(`pending:${callbackState}`, JSON.stringify(pending), { expirationTtl: TEN_MIN });

  const callback = `${origin(url)}/oauth/callback`;
  const upstream = new URL(env.HUBSPOT_AUTHORIZE_URL);
  upstream.searchParams.set("client_id", env.HUBSPOT_CLIENT_ID);
  upstream.searchParams.set("redirect_uri", callback);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("scope", env.HUBSPOT_SCOPES);
  upstream.searchParams.set("state", callbackState);
  upstream.searchParams.set("code_challenge", upstream_challenge);
  upstream.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(upstream.toString(), 302);
}

// ────────────────────────── upstream callback handler ──────────────────────

async function handleCallback(_req: Request, env: Env, url: URL): Promise<Response> {
  const params = url.searchParams;
  const upstreamCode = params.get("code");
  const callbackState = params.get("state");
  const upstreamError = params.get("error");
  if (!callbackState) return text("Missing state", 400);
  const pendingRaw = await env.OAUTH_STATE.get(`pending:${callbackState}`);
  if (!pendingRaw) return text("Unknown or expired state", 400);
  const pending: PendingAuth = JSON.parse(pendingRaw);
  await env.OAUTH_STATE.delete(`pending:${callbackState}`);

  if (upstreamError || !upstreamCode) {
    return redirectWithError(pending, upstreamError ?? "access_denied");
  }

  // Exchange HubSpot code for tokens.
  const callback = `${origin(url)}/oauth/callback`;
  const tokenRes = await exchangeUpstreamCode(env, upstreamCode, callback, pending.upstream_verifier);
  if (!tokenRes.ok) {
    return redirectWithError(pending, "upstream_token_exchange_failed", tokenRes.detail);
  }
  const tokens = tokenRes.tokens;

  // Mint our own code, store the upstream tokens against it. Portal will
  // exchange this at /oauth/token, then we move tokens into the SESSIONS KV.
  const ourCode = randomId(48);
  const issued: IssuedCode = {
    registered_client_id: pending.registered_client_id,
    portal_redirect_uri: pending.portal_redirect_uri,
    portal_code_challenge: pending.portal_code_challenge,
    portal_code_challenge_method: pending.portal_code_challenge_method,
    hubspot_access_token: tokens.access_token,
    hubspot_refresh_token: tokens.refresh_token ?? null,
    hubspot_expires_at: tokens.expires_at,
  };
  await env.OAUTH_STATE.put(`code:${ourCode}`, JSON.stringify(issued), { expirationTtl: TEN_MIN });

  const redirect = new URL(pending.portal_redirect_uri);
  redirect.searchParams.set("code", ourCode);
  if (pending.portal_state) redirect.searchParams.set("state", pending.portal_state);
  return Response.redirect(redirect.toString(), 302);
}

function redirectWithError(pending: PendingAuth, error: string, description?: string): Response {
  const redirect = new URL(pending.portal_redirect_uri);
  redirect.searchParams.set("error", error);
  if (description) redirect.searchParams.set("error_description", description);
  if (pending.portal_state) redirect.searchParams.set("state", pending.portal_state);
  return Response.redirect(redirect.toString(), 302);
}

// ────────────────────────────── token endpoint ─────────────────────────────

async function handleToken(req: Request, env: Env, _url: URL): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid_request" }, 400);
  const grant_type = String(form.get("grant_type") ?? "");

  if (grant_type === "authorization_code") {
    return tokenForCode(env, form);
  }
  if (grant_type === "refresh_token") {
    return tokenForRefresh(env, form);
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

async function tokenForCode(env: Env, form: FormData): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const client_id = String(form.get("client_id") ?? "");
  const redirect_uri = String(form.get("redirect_uri") ?? "");
  const code_verifier = String(form.get("code_verifier") ?? "");
  const issuedRaw = await env.OAUTH_STATE.get(`code:${code}`);
  if (!issuedRaw) return json({ error: "invalid_grant" }, 400);
  const issued: IssuedCode = JSON.parse(issuedRaw);
  await env.OAUTH_STATE.delete(`code:${code}`);

  if (issued.registered_client_id !== client_id) return json({ error: "invalid_grant" }, 400);
  if (issued.portal_redirect_uri !== redirect_uri) return json({ error: "invalid_grant" }, 400);
  if (issued.portal_code_challenge) {
    if (issued.portal_code_challenge_method !== "S256") return json({ error: "invalid_grant" }, 400);
    const check = await s256(code_verifier);
    if (check !== issued.portal_code_challenge) return json({ error: "invalid_grant" }, 400);
  }

  const ourAccess = `vbhs_at_${randomId(32)}`;
  const ourRefresh = `vbhs_rt_${randomId(32)}`;
  const session: SessionTokens = {
    hubspot_access_token: issued.hubspot_access_token,
    hubspot_refresh_token: issued.hubspot_refresh_token,
    hubspot_expires_at: issued.hubspot_expires_at,
  };
  await env.SESSIONS.put(`at:${ourAccess}`, JSON.stringify(session), { expirationTtl: THIRTY_DAYS });
  if (issued.hubspot_refresh_token) {
    await env.SESSIONS.put(`rt:${ourRefresh}`, JSON.stringify(session), { expirationTtl: THIRTY_DAYS });
  }

  const expiresIn = Math.max(60, Math.floor((issued.hubspot_expires_at - Date.now()) / 1000));
  const body: Record<string, unknown> = {
    access_token: ourAccess,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: env.HUBSPOT_SCOPES,
  };
  if (issued.hubspot_refresh_token) body.refresh_token = ourRefresh;
  return json(body);
}

async function tokenForRefresh(env: Env, form: FormData): Promise<Response> {
  const refresh = String(form.get("refresh_token") ?? "");
  const sessionRaw = await env.SESSIONS.get(`rt:${refresh}`);
  if (!sessionRaw) return json({ error: "invalid_grant" }, 400);
  const session: SessionTokens = JSON.parse(sessionRaw);
  if (!session.hubspot_refresh_token) return json({ error: "invalid_grant" }, 400);
  const refreshed = await refreshUpstream(env, session.hubspot_refresh_token);
  if (!refreshed.ok) return json({ error: "invalid_grant", error_description: refreshed.detail }, 400);
  const updated: SessionTokens = {
    hubspot_access_token: refreshed.tokens.access_token,
    hubspot_refresh_token: refreshed.tokens.refresh_token ?? session.hubspot_refresh_token,
    hubspot_expires_at: refreshed.tokens.expires_at,
  };
  const ourAccess = `vbhs_at_${randomId(32)}`;
  const ourRefresh = `vbhs_rt_${randomId(32)}`;
  await env.SESSIONS.delete(`rt:${refresh}`);
  await env.SESSIONS.put(`at:${ourAccess}`, JSON.stringify(updated), { expirationTtl: THIRTY_DAYS });
  await env.SESSIONS.put(`rt:${ourRefresh}`, JSON.stringify(updated), { expirationTtl: THIRTY_DAYS });
  const expiresIn = Math.max(60, Math.floor((updated.hubspot_expires_at - Date.now()) / 1000));
  return json({
    access_token: ourAccess,
    refresh_token: ourRefresh,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: env.HUBSPOT_SCOPES,
  });
}

// ───────────────────────────── MCP transport ───────────────────────────────

async function handleMcp(req: Request, env: Env): Promise<Response> {
  const reqUrl = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return unauthorized(reqUrl);
  const token = m[1].trim();
  const sessionRaw = await env.SESSIONS.get(`at:${token}`);
  if (!sessionRaw) return unauthorized(reqUrl);
  let session: SessionTokens = JSON.parse(sessionRaw);

  // Refresh proactively if within 60s of expiry.
  if (session.hubspot_refresh_token && session.hubspot_expires_at - Date.now() < 60_000) {
    const refreshed = await refreshUpstream(env, session.hubspot_refresh_token);
    if (refreshed.ok) {
      session = {
        hubspot_access_token: refreshed.tokens.access_token,
        hubspot_refresh_token: refreshed.tokens.refresh_token ?? session.hubspot_refresh_token,
        hubspot_expires_at: refreshed.tokens.expires_at,
      };
      await env.SESSIONS.put(`at:${token}`, JSON.stringify(session), { expirationTtl: THIRTY_DAYS });
    }
  }

  // Proxy the MCP request body to HubSpot, swapping the bearer.
  const body = await req.arrayBuffer();
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${session.hubspot_access_token}`);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");

  let upstreamRes = await fetch(env.HUBSPOT_MCP_URL, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  // One automatic refresh-and-retry on 401.
  if (upstreamRes.status === 401 && session.hubspot_refresh_token) {
    const refreshed = await refreshUpstream(env, session.hubspot_refresh_token);
    if (refreshed.ok) {
      session = {
        hubspot_access_token: refreshed.tokens.access_token,
        hubspot_refresh_token: refreshed.tokens.refresh_token ?? session.hubspot_refresh_token,
        hubspot_expires_at: refreshed.tokens.expires_at,
      };
      await env.SESSIONS.put(`at:${token}`, JSON.stringify(session), { expirationTtl: THIRTY_DAYS });
      headers.set("authorization", `Bearer ${session.hubspot_access_token}`);
      upstreamRes = await fetch(env.HUBSPOT_MCP_URL, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    }
  }

  const passthrough = new Headers(upstreamRes.headers);
  passthrough.delete("transfer-encoding");
  passthrough.delete("content-encoding");

  // Log only non-sensitive response metadata. Upstream error bodies can contain
  // tenant data and must not be forwarded to external observability sinks.
  if (upstreamRes.status >= 400 && upstreamRes.status !== 405) {
    console.warn(
      "[mcp←hubspot] non-2xx status=",
      upstreamRes.status,
      "ct=",
      upstreamRes.headers.get("content-type") ?? "",
    );
  }
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: passthrough });
}

function unauthorized(reqUrl: URL): Response {
  const metadataUrl = `${origin(reqUrl)}/.well-known/oauth-protected-resource`;
  const headers = new Headers({
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    "content-type": "application/json",
  });
  return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers });
}

// ─────────────────────────── upstream HubSpot OAuth ────────────────────────

type UpstreamTokens = { access_token: string; refresh_token?: string; expires_at: number };
type UpstreamResult = { ok: true; tokens: UpstreamTokens } | { ok: false; detail: string };

async function exchangeUpstreamCode(
  env: Env,
  code: string,
  redirect_uri: string,
  code_verifier: string,
): Promise<UpstreamResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    redirect_uri,
    code,
    code_verifier,
  });
  return postTokenRequest(env, body);
}

async function refreshUpstream(env: Env, refresh_token: string): Promise<UpstreamResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    refresh_token,
  });
  return postTokenRequest(env, body);
}

async function postTokenRequest(env: Env, body: URLSearchParams): Promise<UpstreamResult> {
  const res = await fetch(env.HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  if (!res.ok) return { ok: false, detail: `${res.status} ${txt.slice(0, 200)}` };
  let parsed: any;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return { ok: false, detail: "non-JSON response from HubSpot" };
  }
  if (!parsed.access_token) return { ok: false, detail: "missing access_token" };
  const expires_in = typeof parsed.expires_in === "number" ? parsed.expires_in : ONE_HOUR / 2;
  return {
    ok: true,
    tokens: {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    },
  };
}

// ─────────────────────────────── utilities ─────────────────────────────────

function origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function randomId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function s256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(new Uint8Array(hash));
}

function base64url(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
