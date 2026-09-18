'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ExternalLink, LoaderCircle, MonitorCog, Server, Sparkles, X } from 'lucide-react';
import type { ModelChoice } from '../lib/agent-profile';
import { ControlClient } from '../lib/control-client';
import type { OnboardingStatus, ReadinessCheck } from '../lib/onboarding';
import { PROVIDERS, type Provider } from '../lib/provider';

type Props = {
  client: ControlClient;
  model: ModelChoice;
  revision: number;
  onModelSaved: (model: ModelChoice, revision: number) => void;
  onComputerSettings: () => void;
  onFinished: () => void;
};

const keyFor = (provider: string) => ({ xai: 'XAI_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as Record<string,string>)[provider] || '';
const providerHelp = { xai: 'https://console.x.ai/', openai: 'https://platform.openai.com/api-keys', openrouter: 'https://openrouter.ai/settings/keys' } as Record<string,string>;

function CheckRow({ check, busy, onAction }: { check: ReadinessCheck; busy: boolean; onAction: (action: NonNullable<ReadinessCheck['action']>) => void }) {
  return <div className={`onboarding-check ${check.state}`}>
    <span className="onboarding-check-icon" aria-hidden="true">{check.state === 'ready' ? <Check size={17} /> : check.state === 'unavailable' ? <span>—</span> : <CircleAlert size={17} />}</span>
    <div><strong>{check.label}</strong><small>{check.detail}</small></div>
    {check.action && <button type="button" className="subtle-button" disabled={busy} onClick={() => onAction(check.action!)}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{check.actionLabel}</button>}
    {check.helpUrl && <a className="subtle-button" href={check.helpUrl} target="_blank" rel="noreferrer">Install <ExternalLink size={13} /></a>}
  </div>;
}

export default function Onboarding({ client, model, revision, onModelSaved, onComputerSettings, onFinished }: Props) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const initialProvider = Object.hasOwn(PROVIDERS, model.provider) ? model.provider as Provider : 'xai';
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [modelId, setModelId] = useState(model.model || PROVIDERS[initialProvider].model);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [modelReady, setModelReady] = useState(false);

  async function refresh() {
    setBusy('status'); setMessage('');
    try { setStatus(await client.request<OnboardingStatus>('/v1/onboarding/status')); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not check this computer.'); }
    finally { setBusy(''); }
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([client.request<OnboardingStatus>('/v1/onboarding/status'), client.request<{ secrets: string[] }>('/v1/health')]).then(([value, health]) => { if (!cancelled) { setStatus(value); setSecretNames(value.credentialNames || health.secrets); } }, error => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not check this computer.'); }).finally(() => { if (!cancelled) setBusy(''); });
    return () => { cancelled = true; };
  }, [client]);

  async function action(value: NonNullable<ReadinessCheck['action']>) {
    setBusy(value); setMessage(value === 'prepare-runtime' ? 'Preparing the agent runtime. Keep Open Harness open; the first setup can take several minutes.' : 'Starting Docker…');
    try { setStatus(await client.request<OnboardingStatus>('/v1/onboarding/action', { method: 'POST', body: JSON.stringify({ action: value }) })); setMessage('Computer check completed.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Setup could not be completed.'); }
    finally { setBusy(''); }
  }

  async function saveModel() {
    if (!modelId.trim()) { setMessage('Choose or enter a model.'); return; }
    if (provider !== 'local' && !apiKey && !secretNames.includes(keyFor(provider))) { setMessage('Paste an API key, or choose a local model server.'); return; }
    setBusy('model'); setMessage('Saving and testing the connection…');
    const credentialRef = provider === 'local' ? '' : keyFor(provider);
    const selected: ModelChoice = { provider, model: modelId.trim(), baseUrl: provider === 'local' ? baseUrl.trim() : '', credentialRef };
    try {
      if (apiKey && credentialRef) { await client.request('/v1/secrets', { method: 'POST', body: JSON.stringify({ name: credentialRef, value: apiKey, ...(status?.credentialMode === 'runner' ? { machineId: status.credentialMachineId } : {}) }) }); setSecretNames(current => [...new Set([...current, credentialRef])]); }
      const saved = await client.request<{ model: ModelChoice; revision: number }>('/v1/workspace/model', { method: 'PUT', body: JSON.stringify({ revision, model: selected }) });
      const test = await client.request<{ ok: boolean; message: string }>('/v1/onboarding/model-test', { method: 'POST', body: JSON.stringify({ model: saved.model }) });
      onModelSaved(saved.model, saved.revision); setApiKey(''); setModelReady(test.ok); setMessage(test.message);
      if (test.ok) setTimeout(() => setStep(3), 450);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the model connection.'); }
    finally { setBusy(''); }
  }

  return <div className="modal-backdrop onboarding-backdrop">
    <section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <header><div><div className="eyebrow">FIRST-RUN SETUP</div><h2 id="onboarding-title">{['Welcome to Open Harness', 'Check this computer', 'Connect your model', 'You’re ready'][step]}</h2></div><button type="button" aria-label="Set up later" onClick={onFinished}><X size={19} /></button></header>
      <div className="onboarding-progress" aria-label={`Step ${step + 1} of 4`}>{[0,1,2,3].map(item => <span className={item <= step ? 'active' : ''} key={item} />)}</div>

      {step === 0 && <div className="onboarding-step">
        <div className="onboarding-hero"><span><Sparkles size={26} /></span><h3>Your agents can keep working on a computer you control.</h3><p>Open Harness stores its data here. You can add a server or another computer whenever you want.</p></div>
        <button type="button" className="onboarding-choice" onClick={() => setStep(1)}><MonitorCog size={23} /><span><strong>Use this computer</strong><small>Recommended for your first agent. We’ll check everything for you.</small></span><ArrowRight size={18} /></button>
        <button type="button" className="onboarding-choice" onClick={onComputerSettings}><Server size={23} /><span><strong>Connect another computer</strong><small>Pair a VPS, home server, Mac, Windows PC, or Linux machine.</small></span><ArrowRight size={18} /></button>
      </div>}

      {step === 1 && <div className="onboarding-step">
        <p className="onboarding-lead">These checks stay on your computer. Open Harness will tell you what it can fix and give you a direct link for anything you need to install.</p>
        <div className="onboarding-checks">{status?.checks.map(check => <CheckRow key={check.id} check={check} busy={Boolean(busy)} onAction={action} />)}</div>
        {!status && !message && <p className="onboarding-working"><LoaderCircle className="spin" size={17} /> Checking this computer…</p>}
        {message && <p className="onboarding-message" role="status">{message}</p>}
        <div className="onboarding-actions"><button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={refresh}>Check again</button><button type="button" className="light-button" disabled={!status?.executionReady || Boolean(busy)} onClick={() => { setMessage(''); setStep(2); }}>Continue <ArrowRight size={14} /></button></div>
        {status && !status.executionReady && <button type="button" className="onboarding-skip" onClick={() => setStep(2)}>Connect my model while I finish this later</button>}
      </div>}

      {step === 2 && <div className="onboarding-step">
        <p className="onboarding-lead">Use an API key from a model provider, or connect a compatible model server running on your network.</p>
        <label>Provider<select value={provider} onChange={event => { const next = event.target.value as Provider; setProvider(next); setModelId(PROVIDERS[next].model); setBaseUrl(''); setMessage(''); }}>{Object.entries(PROVIDERS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></label>
        <label>Model<input value={modelId} onChange={event => setModelId(event.target.value)} placeholder="Model ID" /></label>
        {provider === 'local' ? <label>Model server address<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:11434/v1" /><small>Enter the OpenAI-compatible API address shown by your model app.</small></label> : <label>API key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" placeholder={secretNames.includes(keyFor(provider)) ? 'A saved key is available — paste only to replace it' : 'Paste your API key'} /><small>{status?.credentialMode === 'runner' ? 'The key is encrypted for the connected computer and saved by its OS credential vault. The hosted coordinator cannot decrypt it.' : 'The key is stored on your coordinator and is only sent to runs that use it.'} <a href={providerHelp[provider]} target="_blank" rel="noreferrer">Get a key <ExternalLink size={11} /></a></small></label>}
        {message && <p className={`onboarding-message ${modelReady ? 'success' : ''}`} role="status">{message}</p>}
        <div className="onboarding-actions"><button type="button" className="subtle-button" onClick={() => setStep(1)}><ArrowLeft size={14} /> Back</button><button type="button" className="light-button" disabled={busy === 'model'} onClick={saveModel}>{busy === 'model' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save and test</button></div>
      </div>}

      {step === 3 && <div className="onboarding-step onboarding-done">
        <span><Check size={34} /></span><h3>Open Harness is set up.</h3><p>Your first agent uses a private workspace on this computer. You can change its computer, access, desktop, and limits from Agent settings at any time.</p>
        <button type="button" className="light-button" onClick={onFinished}>Start using Open Harness <ArrowRight size={15} /></button>
        <button type="button" className="subtle-button" onClick={onComputerSettings}>Review computer settings</button>
      </div>}
      {step < 3 && <footer>Your setup is saved as you go. You can close this window and return from Workspace settings.</footer>}
    </section>
  </div>;
}
