'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, QrCode, Smartphone } from 'lucide-react';
import { devicePlatform, normalizePairingCode, pairDevice, parsePairingLink, validateHubUrl, type DeviceCredential } from '../lib/hub';
import { hasTauri, loadTauriPlugin, platformFetch } from '../lib/platform';

type Props = {
  onConnected: (credential: DeviceCredential) => void;
  // Set when the client is already being served by the hub, which is the case for a browser
  // opened at a self-hosted coordinator. There is then nothing to type and nothing to get
  // wrong, so the field is not shown at all.
  fixedHubUrl?: string;
};

// The first thing someone sees on a phone, and now also the first thing a browser sees when
// it reached the dashboard over the network. It has one job: get this device paired to a
// coordinator. Everything it asks for is on the screen of the computer running that
// coordinator, so the wording points back there rather than explaining the architecture.
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
  const [scanning, setScanning] = useState(false);

  const applyLink = useCallback((raw: string) => {
    const link = parsePairingLink(raw);
    if (!link) return false;
    setHubUrl(link.hubUrl);
    setCode(link.code);
    if (link.sitesToken) setSitesToken(link.sitesToken);
    setError('');
    return true;
  }, []);

  // Opening the pairing link from a message or a QR scan should fill the form, not ask the
  // person to retype what they just tapped.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void (async () => {
      type DeepLink = { getCurrent?(): Promise<string[] | null>; onOpenUrl(handler: (urls: string[]) => void): Promise<() => void> };
      const plugin = await loadTauriPlugin<DeepLink>('deep-link');
      if (!plugin) return;
      try {
        const current = await plugin.getCurrent?.();
        if (Array.isArray(current)) for (const url of current) if (applyLink(String(url))) break;
        dispose = await plugin.onOpenUrl(urls => { for (const url of urls) if (applyLink(String(url))) break; });
      } catch { /* No deep link waiting; the form still works by hand. */ }
    })();
    return () => dispose?.();
  }, [applyLink]);

  async function scan() {
    setError(''); setScanning(true);
    try {
      type Scanner = { checkPermissions(): Promise<string>; requestPermissions(): Promise<string>; scan(options: Record<string, unknown>): Promise<{ content?: string }>; Format: { QRCode: unknown } };
      const plugin = await loadTauriPlugin<Scanner>('barcode-scanner');
      if (!plugin) throw new Error('Scanning is not available in this build. Type the address and code instead.');
      const permission = await plugin.checkPermissions();
      if (permission !== 'granted' && (await plugin.requestPermissions()) !== 'granted') {
        throw new Error('Camera access is needed to scan the pairing code. You can type it instead.');
      }
      const result = await plugin.scan({ windowed: false, formats: [plugin.Format.QRCode] });
      if (!applyLink(String(result?.content || ''))) throw new Error('That QR code is not an Open Harness pairing code.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not scan a code. Type the address and code instead.');
    } finally { setScanning(false); }
  }

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
          <Smartphone size={26} aria-hidden="true" />
          <h1>{fixedHubUrl ? 'Connect this device' : 'Connect this phone'}</h1>
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

        {hasTauri() && (
          <button type="button" className="light-button hub-scan" disabled={scanning} onClick={() => void scan()}>
            {scanning ? <LoaderCircle className="spin" size={15} /> : <QrCode size={15} />} {scanning ? 'Scanning…' : 'Scan the pairing code'}
          </button>
        )}

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
            <small>Only needed when your hub is a hosted Open Harness site. The pairing link fills this in for you.</small>
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
