// Google Drive sync — the side-effectful half of [[sync-approach]]. Keeps one JSON
// snapshot in the user's PRIVATE appDataFolder (drive.appdata scope: a hidden folder
// only this app can see — even a leaked token can't reach the rest of his Drive).
//
// Auth: OAuth 2.0 authorization-code + PKCE, full-page redirect (no popups — those
// are unreliable in an installed mobile PWA, which is exactly where this kept
// breaking). The one-time code→token exchange and later refresh-token exchanges need
// the Google client SECRET, which can't live in the browser; a tiny same-origin
// Worker route (worker/index.ts) holds it and relays those two calls. Everything else
// — the Drive REST calls that actually move data — still goes straight from the
// browser to Google with the access token; no user data ever touches the Worker.
// The refresh token itself lives in localStorage and doesn't expire on its own, so
// this survives reloads/new tabs without ever re-showing the consent screen.
//
// The pure decision/merge logic lives in dbSnapshot.ts; this file is the plumbing.

import {
  applySnapshot,
  buildSnapshot,
  hashData,
  resolveSync,
  summarize,
  type Snapshot,
  type SnapshotMeta,
} from "./dbSnapshot";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "shift-dashboard.json";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const LS = {
  clientId: "sync.clientId",
  connected: "sync.connected", // "1" once we're holding a usable refresh token
  refreshToken: "sync.refreshToken",
  deviceName: "sync.deviceName",
  lastSyncedHash: "sync.lastSyncedHash",
  lastSyncedAt: "sync.lastSyncedAt",
} as const;

// PKCE state for the in-flight redirect round trip only; cleared once consumed.
const SS = {
  codeVerifier: "sync.oauth.codeVerifier",
  state: "sync.oauth.state",
} as const;

// --- Config & sync metadata (per-device, in localStorage — never itself synced) ---

export function getClientId(): string {
  return localStorage.getItem(LS.clientId) || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "");
}
export function setClientId(id: string): void {
  const v = id.trim();
  if (v) localStorage.setItem(LS.clientId, v);
  else localStorage.removeItem(LS.clientId);
}
export function isConfigured(): boolean {
  return !!getClientId();
}
export function isConnected(): boolean {
  return localStorage.getItem(LS.connected) === "1" && !!localStorage.getItem(LS.refreshToken);
}
export function getDeviceName(): string {
  return localStorage.getItem(LS.deviceName) || defaultDeviceName();
}
export function setDeviceName(name: string): void {
  localStorage.setItem(LS.deviceName, name.trim() || defaultDeviceName());
}
export function lastSyncedAt(): string | null {
  return localStorage.getItem(LS.lastSyncedAt);
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Mobi|Android|iPhone/i.test(ua)) return "Phone";
  return "PC";
}

function rememberSynced(hash: string): void {
  localStorage.setItem(LS.lastSyncedHash, hash);
  localStorage.setItem(LS.lastSyncedAt, new Date().toISOString());
}

/** Drop the local grant record (NOT a revoke — used when the refresh token itself
    turns out to be dead, so the next Connect starts clean). */
function forgetGrant(): void {
  localStorage.removeItem(LS.connected);
  localStorage.removeItem(LS.refreshToken);
}

/** Best-effort revoke at Google + drop the local grant. Revoke doesn't need the
    client secret, so this can happen straight from the browser. */
export async function disconnect(): Promise<void> {
  const refreshToken = localStorage.getItem(LS.refreshToken);
  accessToken = null;
  tokenExpiry = 0;
  forgetGrant();
  if (refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
      });
    } catch {
      // best-effort — the local grant is already gone either way
    }
  }
}

// --- PKCE helpers -----------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function redirectUri(): string {
  // The root path, so the redirect lands back on the SPA (its fallback route)
  // with no special callback page needed. Must exactly match what's registered
  // as an Authorized redirect URI in Google Cloud Console.
  return `${location.origin}/`;
}

/**
 * Explicit user action: build the PKCE challenge, stash it for the trip back, and
 * navigate the whole page to Google's consent screen. There is no popup — installed
 * PWAs on mobile handle full-page redirects far more reliably. This function does
 * not return under normal operation (the page navigates away).
 */
export async function connect(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error("No Google client ID configured.");
  const verifier = randomToken(48);
  const state = randomToken(16);
  sessionStorage.setItem(SS.codeVerifier, verifier);
  sessionStorage.setItem(SS.state, state);
  const challenge = await codeChallengeFor(verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a refresh_token every time, not just on first grant
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  location.href = `${AUTH_URL}?${params}`;
}

/**
 * Call once on app boot. If the URL carries an OAuth redirect (`?code=…&state=…`),
 * exchanges it for tokens via the Worker relay, stores the refresh token, and
 * strips the query string. Safe to call unconditionally — it's a no-op otherwise.
 * Returns true if it just completed a fresh connection.
 */
export async function consumeAuthRedirect(): Promise<boolean> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const authError = url.searchParams.get("error");
  const verifier = sessionStorage.getItem(SS.codeVerifier);
  const expectedState = sessionStorage.getItem(SS.state);
  sessionStorage.removeItem(SS.codeVerifier);
  sessionStorage.removeItem(SS.state);

  if (!code && !authError) return false;

  // Strip the OAuth params so a refresh doesn't try to replay the code.
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("scope");
  url.searchParams.delete("error");
  history.replaceState(null, "", url.toString());

  if (authError || !code || !verifier || !state || state !== expectedState) return false;

  const res = await fetch("/api/google/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: redirectUri() }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || !data.refresh_token) return false;

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  localStorage.setItem(LS.refreshToken, data.refresh_token);
  localStorage.setItem(LS.connected, "1");
  return true;
}

// --- Access token (refreshed via the Worker relay, no GIS/session dependency) ----

let accessToken: string | null = null;
let tokenExpiry = 0;

/** Thrown when Google itself rejected the refresh token (revoked/expired grant) —
    distinct from a network/offline failure, which must NOT force a reconnect. */
class AuthError extends Error {}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in?: number }> {
  const res = await fetch("/api/google/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AuthError(body.error || `Google refresh failed (${res.status})`);
  }
  return res.json();
}

/**
 * Get a usable access token. `interactive` allows falling back to the full consent
 * redirect when there's no usable grant yet; otherwise this just fails.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;
  const refreshToken = localStorage.getItem(LS.refreshToken);
  if (refreshToken) {
    try {
      const data = await refreshAccessToken(refreshToken);
      accessToken = data.access_token;
      tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
      return accessToken;
    } catch (e) {
      if (e instanceof AuthError) forgetGrant();
      throw e;
    }
  }
  if (!interactive) throw new AuthError("Not connected to Google Drive.");
  await connect();
  throw new Error("Redirecting to Google sign-in…"); // unreachable — connect() navigates away
}

// --- Drive REST (appDataFolder) -------------------------------------------

async function driveFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // token died mid-flight — drop it so the next call re-auths
    accessToken = null;
    throw new Error("Google session expired — try Sync again.");
  }
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res;
}

interface RemoteFile {
  id: string;
  snapshot: Snapshot;
}

async function findFileId(token: string): Promise<string | null> {
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?spaces=appDataFolder&q=${encodeURIComponent(`name='${FILE_NAME}'`)}` +
    "&fields=files(id,modifiedTime)&pageSize=1";
  const res = await driveFetch(url, { method: "GET" }, token);
  const json = (await res.json()) as { files?: { id: string }[] };
  return json.files?.[0]?.id ?? null;
}

async function readRemote(token: string): Promise<RemoteFile | null> {
  const id = await findFileId(token);
  if (!id) return null;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    { method: "GET" },
    token,
  );
  const snapshot = (await res.json()) as Snapshot;
  return { id, snapshot };
}

async function writeRemote(token: string, id: string | null, snap: Snapshot): Promise<void> {
  const boundary = "shiftdash-" + Math.random().toString(36).slice(2);
  const metadata = id ? { name: FILE_NAME } : { name: FILE_NAME, parents: ["appDataFolder"] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(snap) +
    `\r\n--${boundary}--`;
  const url =
    `https://www.googleapis.com/upload/drive/v3/files${id ? "/" + id : ""}?uploadType=multipart`;
  await driveFetch(
    url,
    { method: id ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
    token,
  );
}

// --- Orchestration --------------------------------------------------------

export type SyncResult =
  | { status: "in-sync"; at: string }
  | { status: "pushed"; at: string }
  | { status: "pulled"; at: string }
  | { status: "conflict"; local: SnapshotMeta; remote: SnapshotMeta };

/**
 * Reconcile this device with Drive. Auto-resolves push/pull; returns "conflict"
 * (without touching anything) when both sides changed — the UI then asks the user.
 * `interactive` decides whether a missing/dead grant may redirect to consent.
 */
export async function sync(interactive = true): Promise<SyncResult> {
  const token = await getToken(interactive);
  const local = await buildSnapshot(getDeviceName());
  const localHash = hashData(local.data);
  const remote = await readRemote(token);
  const action = resolveSync({
    localHash,
    remoteExists: !!remote,
    remoteHash: remote ? hashData(remote.snapshot.data) : null,
    lastSyncedHash: localStorage.getItem(LS.lastSyncedHash),
  });

  switch (action) {
    case "in-sync":
      rememberSynced(localHash);
      return { status: "in-sync", at: lastSyncedAt()! };
    case "first-push":
    case "push":
      await writeRemote(token, remote?.id ?? null, local);
      rememberSynced(localHash);
      return { status: "pushed", at: lastSyncedAt()! };
    case "pull":
      await applySnapshot(remote!.snapshot);
      rememberSynced(hashData(remote!.snapshot.data));
      return { status: "pulled", at: lastSyncedAt()! };
    case "conflict":
      return { status: "conflict", local: summarize(local), remote: summarize(remote!.snapshot) };
  }
}

/**
 * User picked a side in the conflict guard. "local" overwrites Drive with this
 * device; "remote" overwrites this device with Drive.
 */
export async function resolveConflict(keep: "local" | "remote"): Promise<SyncResult> {
  const token = await getToken(true);
  const remote = await readRemote(token);
  if (keep === "remote") {
    if (!remote) throw new Error("The Drive copy is gone — try Sync now instead.");
    await applySnapshot(remote.snapshot);
    const h = hashData(remote.snapshot.data);
    rememberSynced(h);
    return { status: "pulled", at: lastSyncedAt()! };
  }
  const local = await buildSnapshot(getDeviceName());
  await writeRemote(token, remote?.id ?? null, local);
  rememberSynced(hashData(local.data));
  return { status: "pushed", at: lastSyncedAt()! };
}

/**
 * Best-effort pull/push on app open. Silent (no redirect); if the grant has lapsed
 * or a conflict appears, it backs off so the user deals with it in Settings. Returns
 * the result for an optional banner, or null if sync isn't set up.
 */
export async function syncOnOpen(): Promise<SyncResult | null> {
  if (!isConnected()) return null;
  try {
    return await sync(false);
  } catch (e) {
    // Drop the grant only when Google itself rejected it (revoked/expired refresh
    // token). A transient failure — offline, a flaky connection — must NOT force a
    // manual reconnect; the next open just tries again.
    if (e instanceof AuthError) forgetGrant();
    return null;
  }
}
