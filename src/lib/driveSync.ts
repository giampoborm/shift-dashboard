// Google Drive sync — the side-effectful half of [[sync-approach]]. Keeps one JSON
// snapshot in the user's PRIVATE appDataFolder (drive.appdata scope: a hidden folder
// only this app can see — even a leaked token can't reach the rest of his Drive).
//
// No backend, so no refresh token: we use Google Identity Services' in-browser token
// client. Tokens last ~1h and are re-requested silently while the grant is alive.
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

const LS = {
  clientId: "sync.clientId",
  connected: "sync.connected", // "1" once the user has granted consent at least once
  deviceName: "sync.deviceName",
  lastSyncedHash: "sync.lastSyncedHash",
  lastSyncedAt: "sync.lastSyncedAt",
} as const;

// Minimal shape of the GIS global we use; avoids pulling @types/google.accounts.
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
            error_callback?: (e: { type?: string; message?: string }) => void;
          }): { requestAccessToken(opts?: { prompt?: string }): void };
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

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
  return localStorage.getItem(LS.connected) === "1" && isConfigured();
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

function disconnectLocal(): void {
  localStorage.removeItem(LS.connected);
}

export function disconnect(): void {
  const t = accessToken;
  accessToken = null;
  tokenExpiry = 0;
  disconnectLocal();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t);
}

// --- Google Identity Services loader + token ------------------------------

let gisPromise: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error("Couldn't load Google sign-in. Check your connection / ad-blocker."));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

let accessToken: string | null = null;
let tokenExpiry = 0;

/**
 * Get a usable access token. `interactive` shows the Google consent popup (used by
 * Connect); otherwise we try silently and fail if the grant has lapsed.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;
  await loadGis();
  const clientId = getClientId();
  if (!clientId) throw new Error("No Google client ID configured.");
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new Error(r.error || "Authorization was cancelled."));
          return;
        }
        accessToken = r.access_token;
        tokenExpiry = Date.now() + (r.expires_in ?? 3600) * 1000;
        localStorage.setItem(LS.connected, "1");
        resolve(accessToken);
      },
      error_callback: (e) => reject(new Error(e.message || "Google sign-in failed.")),
    });
    // prompt:"" = silent (reuse existing grant); "consent" forces the chooser.
    client.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

/** Explicit user action: open the consent popup and remember the grant. */
export async function connect(): Promise<void> {
  await getToken(true);
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
    throw new Error("Google session expired — connect again.");
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
 * `interactive` decides whether a lapsed grant may pop the consent dialog.
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
 * Best-effort pull/push on app open. Silent (no popup); if the grant has lapsed or a
 * conflict appears, it backs off so the user deals with it in Settings. Returns the
 * result for an optional banner, or null if sync isn't set up.
 */
export async function syncOnOpen(): Promise<SyncResult | null> {
  if (!isConnected()) return null;
  try {
    return await sync(false);
  } catch (e) {
    // Drop "connected" only when the GRANT is the problem. A transient failure —
    // opening the PWA offline, a flaky connection, GIS blocked by an ad-blocker —
    // must NOT force a manual reconnect; the next open just tries again.
    if (navigator.onLine && isAuthError(e)) disconnectLocal();
    return null;
  }
}

/** Errors that mean the Google grant itself has lapsed/been revoked. Deliberately
    excludes "cancelled": a dismissed consent popup (interactive connect only —
    can't happen in silent syncOnOpen) is not a revoked grant. */
function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /interaction_required|login_required|access_denied|invalid_grant|expired|sign-in failed/.test(
    msg,
  );
}
