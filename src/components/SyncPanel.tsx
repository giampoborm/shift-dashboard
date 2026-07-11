// Google Drive sync section for the Settings panel ([[sync-approach]]).
// All the real work (OAuth, Drive REST, whole-file merge) is in lib/driveSync.ts and
// lib/dbSnapshot.ts; this component is just the controls + the conflict guard prompt.
// After a pull (local DB replaced wholesale) it calls onDataReplaced so App re-reads
// settings — shifts/rates/payslips refresh themselves via Dexie live queries.

import { useState } from "react";
import {
  connect,
  disconnect,
  getClientId,
  getDeviceName,
  isConfigured,
  isConnected,
  lastSyncedAt,
  resolveConflict,
  setClientId,
  setDeviceName,
  sync,
  type SyncResult,
} from "../lib/driveSync";
import type { SnapshotMeta } from "../lib/dbSnapshot";

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

export function SyncPanel(props: { onDataReplaced: () => void }) {
  const [clientId, setClientIdInput] = useState(getClientId());
  const [device, setDevice] = useState(getDeviceName());
  const [configured, setConfigured] = useState(isConfigured());
  const [connected, setConnected] = useState(isConnected());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [synced, setSynced] = useState(lastSyncedAt());
  const [conflict, setConflict] = useState<{ local: SnapshotMeta; remote: SnapshotMeta } | null>(null);

  function applyResult(r: SyncResult) {
    if (r.status === "conflict") {
      setConflict({ local: r.local, remote: r.remote });
      setMsg("");
      return;
    }
    setConflict(null);
    setSynced(r.at);
    setConnected(isConnected());
    if (r.status === "pulled") props.onDataReplaced();
    setMsg(
      r.status === "pushed" ? "Pushed this device → Drive ✓"
      : r.status === "pulled" ? "Pulled Drive → this device ✓"
      : "Already up to date ✓",
    );
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function saveClientId() {
    setClientId(clientId);
    setDeviceName(device);
    setConfigured(isConfigured());
    setConnected(isConnected());
    setMsg("Saved ✓");
    setErr("");
  }

  return (
    <section className="sync">
      <h3>Cloud sync (Google Drive)</h3>
      <p className="hint">
        Keeps your shifts on phone and PC in step through one hidden file in <strong>your own</strong> Google
        Drive (the private <code>appdata</code> folder — no other app, and no server of ours, can read it).
        Whole-file, newer-wins: if both devices changed since the last sync, you’ll be asked which to keep.
      </p>

      {!configured && <SetupHelp origin={ORIGIN} />}

      <div className="grid">
        <label>
          Google OAuth client ID
          <input
            value={clientId}
            onChange={(e) => setClientIdInput(e.target.value)}
            placeholder="1234-abc.apps.googleusercontent.com"
            spellCheck={false}
          />
        </label>
        <label>
          This device’s name
          <input value={device} onChange={(e) => setDevice(e.target.value)} placeholder="PC / Phone" />
        </label>
      </div>
      <div className="row-actions" style={{ marginTop: "0.6rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
        <button onClick={saveClientId}>Save</button>
        {configured && !connected && (
          // connect() redirects the whole page to Google's consent screen and
          // back — there's nothing meaningful to await here, the app reloads.
          <button className="primary" disabled={busy} onClick={() => run(() => connect())}>
            Connect Google Drive
          </button>
        )}
        {configured && connected && (
          <>
            <button className="primary" disabled={busy} onClick={() => run(async () => applyResult(await sync(true)))}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button disabled={busy} onClick={() => run(async () => {
              await disconnect();
              setConnected(false);
              setMsg("Disconnected (data stays on this device).");
            })}>
              Disconnect
            </button>
          </>
        )}
        <span className="muted" style={{ marginLeft: "auto", fontSize: "0.76rem" }}>
          Last synced: {when(synced)}
        </span>
      </div>

      {conflict && (
        <div className="conflict">
          <p className="err" style={{ margin: "0 0 0.5rem" }}>
            ⚠ Both this device and Drive changed since the last sync. Keep which? The other side’s changes will be overwritten.
          </p>
          <div className="conflict-cards">
            <ConflictCard title="This device" meta={conflict.local} />
            <ConflictCard title="Google Drive" meta={conflict.remote} />
          </div>
          <div className="row-actions" style={{ marginTop: "0.6rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button className="primary" disabled={busy} onClick={() => run(async () => applyResult(await resolveConflict("local")))}>
              Keep this device → Drive
            </button>
            <button className="danger" disabled={busy} onClick={() => run(async () => applyResult(await resolveConflict("remote")))}>
              Keep Drive → this device
            </button>
            <button disabled={busy} onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </div>
      )}

      {msg && <p className="saved">{msg}</p>}
      {err && <p className="err" style={{ margin: "0.4rem 0 0" }}>{err}</p>}
    </section>
  );
}

function ConflictCard(props: { title: string; meta: SnapshotMeta }) {
  const c = props.meta.counts;
  return (
    <div className="conflict-card">
      <strong>{props.title}</strong>
      <div className="muted" style={{ fontSize: "0.76rem" }}>{props.meta.device} · saved {when(props.meta.savedAt)}</div>
      <div className="muted" style={{ fontSize: "0.76rem" }}>
        {c.shifts} shifts · {c.rates} rates · {c.payslips} payslips · {c.vacations} vacations
      </div>
    </div>
  );
}

function SetupHelp(props: { origin: string }) {
  return (
    <details className="setup-help">
      <summary>One-time setup — create your free Google client ID</summary>
      <ol>
        <li>Go to <code>console.cloud.google.com</code> → create a project.</li>
        <li><strong>APIs &amp; Services → Library</strong> → enable <strong>Google Drive API</strong>.</li>
        <li><strong>OAuth consent screen</strong> → <em>External</em>, keep it in <strong>Testing</strong>, add yourself as a test user, add the scope <code>.../auth/drive.appdata</code>.</li>
        <li><strong>Credentials → Create credentials → OAuth client ID</strong> → type <em>Web application</em>. Under <strong>Authorized JavaScript origins</strong> add <code>{props.origin || "https://your-app-url"}</code>. Under <strong>Authorized redirect URIs</strong> add <code>{props.origin ? `${props.origin}/` : "https://your-app-url/"}</code> — this must match exactly (trailing slash included).</li>
        <li>Copy the <strong>Client ID</strong> here and press Save. The matching <strong>Client secret</strong> does NOT go here — it's set once as a Cloudflare Worker secret so it never ships to the browser (see deployment notes).</li>
        <li>Press Connect — you'll be sent to Google's consent screen and back.</li>
      </ol>
      <p className="muted" style={{ fontSize: "0.74rem" }}>
        The client ID isn’t a secret (it ships in the page); access is gated by the redirect URI you registered and your Google login.
      </p>
    </details>
  );
}
