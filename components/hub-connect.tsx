'use client';

import { useState } from 'react';
import { CircleAlert, LoaderCircle, Monitor } from 'lucide-react';
import { devicePlatform, normalizePairingCode, pairDevice, validateHubUrl, type DeviceCredential } from '../lib/hub';
import { platformFetch } from '../lib/platform';

type Props = {
  onConnected: (credential: DeviceCredential) => void;
  // Set when the client is already being served by the hub, which is the case for a browser
  // opened at a self-hosted coordinator. There is then nothing to type and nothing to get
  // wrong, so the field is not shown at all.
  fixedHubUrl?: string;
};

// Pair a browser with the coordinator that serves its dashboard.
export function HubConnect({ onConnected, fixedHubUrl }: Props) {
  // Read once at first render: the answer cannot change while the screen is open, and
  // seeding state from it avoids writing state from an effect.
  const [device] = useState(devicePlatform);
  const [hubUrl, setHubUrl] = useState(fixedHubUrl || '');
  const [code, setCode] = useState('');
  const [sitesToken, setSitesToken] = useState('');
  const [name, setName] = useState(() => device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    setBusy(true); setError('');
    try {
      const credential = await pairDevice({
        hubUrl: validateHubUrl(hubUrl),
        code,
        ...(sitesToken.trim() ? { sitesToken: sitesToken.trim() } : {}),
        name: name.trim() || device.name,
        platform: device.platform,
        fetchImpl: await platformFetch(),
      });
      onConnected(credential);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to that hub.');
    } finally { setBusy(false); }
  }

  const ready = Boolean(hubUrl.trim() && normalizePairingCode(code));

  return (
    <div className="hub-connect">
      <div className="hub-connect-panel">
        <div className="hub-connect-heading">
          <Monitor size={26} aria-hidden="true" />
          <h1>Connect this device</h1>
          <p>
            Open Harness runs your agents on a computer you control. Pair this device with it
            to follow agents, send tasks, and approve their work.
            {fixedHubUrl ? ' Your agents stay on that computer; nothing runs here.' : ''}
          </p>
        </div>

        <ol className="hub-connect-steps">
          <li>On that computer, open Open Harness and go to Agent settings, then Computer.</li>
          <li>Choose Add computer, pick {device.platform === 'ios' ? 'iPhone or iPad' : 'Android'}, and create a pairing code.</li>
          <li>{fixedHubUrl ? 'Enter the code it shows you.' : 'Enter the address and code it shows you.'}</li>
        </ol>

        {!fixedHubUrl && (
          <label>Hub address
            <input inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={hubUrl} onChange={event => setHubUrl(event.target.value)} placeholder="https://agents.example.com" />
            <small>The HTTPS address of your coordinator, shown with the pairing code.</small>
          </label>
        )}

        <label>Pairing code
          <input className="computer-pairing-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="K4M2 7QRT 9XBV" />
        </label>

        <details className="profile-advanced">
          <summary>This device&rsquo;s name and hosted access</summary>
          <label>Device name<input value={name} onChange={event => setName(event.target.value)} placeholder={device.name} /></label>
          <label>Hosted access token <span className="profile-optional">hosted dashboards only</span>
            <input autoCapitalize="none" autoCorrect="off" spellCheck={false} value={sitesToken} onChange={event => setSitesToken(event.target.value)} />
            <small>Only needed when your hub is a hosted Open Harness site. Ask the operator for the hosted access token.</small>
          </label>
        </details>

        {error && <p role="alert" className="hub-connect-error"><CircleAlert size={15} aria-hidden="true" /> {error}</p>}

        <button type="button" className="new-button" disabled={!ready || busy} onClick={() => void connect()}>
          {busy ? <><LoaderCircle className="spin" size={15} /> Connecting…</> : 'Connect'}
        </button>
        <p className="hub-connect-footnote">This device gets its own credential, which only reaches the dashboard and never your agents&rsquo; computers. You can disconnect it from either end at any time.</p>
      </div>
    </div>
  );
}
