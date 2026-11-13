"use client";

import { useEffect, useState } from "react";
import type { ControlClient } from "@/lib/control-client";
import styles from "./availability-settings.module.css";

export type Availability = { deployment: "compose" | "native"; publicUrl: string | null; browserPairing: boolean; remoteReady: boolean };
export default function AvailabilitySettings({ client }: { client: ControlClient }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    let cancelled = false;
    void client.request<Availability>("/v1/availability").then(value => { if (!cancelled) setAvailability(value); }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Server availability could not be checked."); });
    const timer = window.setInterval(() => setClock(Date.now()), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client]);
  const expired = link ? Date.parse(link.expiresAt) <= clock : false;
  async function createLink() {
    setBusy(true); setError(""); setNotice("");
    try { setLink(await client.request("/v1/browser/link", { method: "POST", body: "{}" })); setClock(Date.now()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "A phone connection link could not be created."); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!link || expired) return;
    try { await navigator.clipboard.writeText(link.url); setNotice("Connection link copied. Open it on your own phone before it expires."); }
    catch { setNotice("Select and copy the connection link below."); }
  }
  return <section className={styles.panel} aria-label="Always-on access">
    <h3>Keep working while you’re away</h3>
    <p>Closing this page keeps active work running. The coordinator and agent computer must stay powered on and connected. Saved routines resume when the coordinator starts again; it runs one overdue occurrence rather than replaying every missed run.</p>
    {availability && <p className={styles.status}>{availability.deployment === "compose" ? "Running with Docker Compose · keep the host and Docker running" : "Running on your computer · install the background service for automatic startup"}</p>}
    <h4>Connect your phone</h4>
    <p>Use the same agents, conversations, approvals, and computer controls from a paired browser. A connection link grants access to this workspace and can be used once.</p>
    {availability?.remoteReady ? <><p className={styles.status}>Server address: {availability.publicUrl}</p><button type="button" disabled={busy} onClick={() => void createLink()}>{busy ? "Creating link…" : "Create phone connection link"}</button></> : <p className={styles.status}>Configure authenticated HTTPS access and browser pairing to create a phone connection link.</p>}
    {link && <div className={styles.link}><label>One-use phone connection link<input readOnly value={expired ? "This connection link has expired." : link.url} onFocus={event => event.target.select()} /></label><p>{expired ? "Create another link when you’re ready." : `Expires ${new Date(link.expiresAt).toLocaleTimeString()}. Keep this link private.`}</p><div className={styles.actions}><button type="button" disabled={expired} onClick={() => void copyLink()}>Copy phone link</button><button type="button" disabled={expired} onClick={() => { if (navigator.share && link) void navigator.share({ title: "Open Harness connection", url: link.url }).catch(() => {}); else void copyLink(); }}>Share phone link</button><button type="button" onClick={() => { setLink(null); setNotice(""); }}>Hide connection link</button></div></div>}
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details><summary>Set up an always-on server</summary><ol><li>Use a Linux computer or server that stays on. Install Docker with Compose 2.24.4 or later.</li><li>Install Tailscale on the server and your phone, then sign into the same private network. Limit access to your own devices.</li><li>From an Open Harness source checkout on the server, run the private-server setup with that server’s Tailscale DNS name:<code>bash deploy/private-server/start.sh your-server.your-tailnet.ts.net</code></li><li>Open the one-use link printed by setup. Prepare the agent runtime and connect your model in the first-run guide.</li><li>Return here to connect another device. On iPhone, add the dashboard to your Home Screen, then enable notifications in this workspace.</li></ol><p>This preset keeps the dashboard on loopback and uses private HTTPS through Tailscale Serve. It requires an always-on server and a Tailscale connection on your phone. Setup does not move this workspace’s files; follow the backup/restore guide if you are moving existing work.</p><p>For this computer instead, install the background service from the source checkout with <code>npm run harness:install-service</code> and start it with <code>npm run harness:start</code>. A sleeping or powered-off computer cannot run tasks.</p></details>
  </section>;
}
