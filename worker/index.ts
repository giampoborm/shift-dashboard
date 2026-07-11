// Cloudflare Worker: serves the built SPA (dist/) as before, plus two small OAuth
// relay routes that hold the Google client secret server-side so the browser never
// sees it. This is the ONLY server logic in the app — no user data ever passes
// through it, just the one-time authorization-code exchange and later refresh-token
// exchanges for Google Drive sync ([[sync-approach]]). See driveSync.ts for the
// client half (PKCE authorization-code flow, full-page redirect, no popups —
// popups are unreliable in an installed mobile PWA).

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function googleToken(params: URLSearchParams): Promise<Response> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) return json({ error: (data.error as string) ?? "token_request_failed" }, 400);
  return json(data);
}

async function handleExchange(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: "server_not_configured" }, 500);
  }
  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    codeVerifier?: string;
    redirectUri?: string;
  };
  if (!body.code || !body.codeVerifier || !body.redirectUri) {
    return json({ error: "missing_params" }, 400);
  }
  return googleToken(
    new URLSearchParams({
      code: body.code,
      code_verifier: body.codeVerifier,
      redirect_uri: body.redirectUri,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "authorization_code",
    }),
  );
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: "server_not_configured" }, 500);
  }
  const body = (await request.json().catch(() => ({}))) as { refreshToken?: string };
  if (!body.refreshToken) return json({ error: "missing_params" }, 400);
  return googleToken(
    new URLSearchParams({
      refresh_token: body.refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/google/exchange") {
      return handleExchange(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/google/refresh") {
      return handleRefresh(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
