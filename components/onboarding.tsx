'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ExternalLink, LoaderCircle, MonitorCog, Server, Sparkles, X } from 'lucide-react';
import type { ModelChoice } from '../lib/agent-profile';
import { ControlClient } from '../lib/control-client';
import type { OnboardingStatus, ReadinessCheck, SetupJob } from '../lib/onboarding';
import { PROVIDERS, type Provider } from '../lib/provider';

/** Non-secret wizard draft. Cleared when setup finishes; kept on “Set up later”. */
const ONBOARDING_PROGRESS_KEY = 'open-harness.onboarding.progress.v1';

type Props = {
  client: ControlClient;
  model: ModelChoice;
  revision: number;
  onModelSaved: (model: ModelChoice, revision: number) => void;
  onComputerSettings: () => void;
  onDismiss: () => void;
  onFinished: () => void;
};

type Progress = {
  step: number;
  provider: Provider;
  modelId: string;
  baseUrl: string;
  verifiedRevision: number | null;
};

const keyFor = (provider: string) => ({ xai: 'XAI_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as Record<string,string>)[provider] || '';
const providerHelp = { xai: 'https://console.x.ai/', openai: 'https://platform.openai.com/api-keys', openrouter: 'https://openrouter.ai/settings/keys' } as Record<string,string>;
const selfHosted = process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1';
const POLL_MS = 2_000;

function readStatus(client: ControlClient) {
  // A cold Docker mount check can take 60 seconds after the shorter discovery probes.
  return client.request<OnboardingStatus>('/v1/onboarding/status', { signal: AbortSignal.timeout(90_000) });
}

function readProgress(): Progress | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ONBOARDING_PROGRESS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Progress>;
    const provider = value.provider && Object.hasOwn(PROVIDERS, value.provider) ? value.provider as Provider : null;
    const step = typeof value.step === 'number' && value.step >= 0 && value.step <= 3 ? Math.floor(value.step) : null;
    if (provider == null || step == null) return null;
    return {
      step,
      provider,
      modelId: typeof value.modelId === 'string' ? value.modelId : PROVIDERS[provider].model,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      verifiedRevision: typeof value.verifiedRevision === 'number' ? value.verifiedRevision : null,
    };
  } catch {
    return null;
  }
}

function writeProgress(progress: Progress) {
  // A pasted endpoint can contain credentials before the form validates it.
  let baseUrl = '';
  try {
    const url = new URL(progress.baseUrl);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) baseUrl = progress.baseUrl;
  } catch { /* keep unfinished addresses in memory */ }
  try { localStorage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify({ ...progress, baseUrl })); } catch { /* private mode */ }
}

function CheckRow({ check, busy, job, onAction }: {
  check: ReadinessCheck;
  busy: boolean;
  job?: SetupJob;
  onAction: (action: NonNullable<ReadinessCheck['action']>) => void;
}) {
  const jobBusy = Boolean(check.action && job?.action === check.action && job.state === 'running');
  const jobFailed = Boolean(check.action && job?.action === check.action && job.state === 'failed');
  return <div className={`onboarding-check ${jobFailed ? 'action' : check.state}`}>
    <span className="onboarding-check-icon" aria-hidden="true">{check.state === 'ready' && !jobFailed ? <Check size={17} /> : check.state === 'unavailable' ? <span>—</span> : <CircleAlert size={17} />}</span>
    <div>
      <strong>{check.label}</strong>
      <small>{check.detail}</small>
    </div>
    {check.action && <button type="button" className="subtle-button" disabled={busy || jobBusy} onClick={() => onAction(check.action!)}>
      {jobBusy ? <LoaderCircle className="spin" size={14} /> : null}
      {jobBusy ? 'Working…' : jobFailed ? 'Try again' : check.actionLabel}
    </button>}
    {check.helpUrl && <a className="subtle-button" href={check.helpUrl} target="_blank" rel="noreferrer">Install <ExternalLink size={13} /></a>}
  </div>;
}

export default function Onboarding({ client, model, revision, onModelSaved, onComputerSettings, onDismiss, onFinished }: Props) {
  const [saved] = useState(readProgress);
  const initialProvider = saved?.provider ?? (Object.hasOwn(PROVIDERS, model.provider) ? model.provider as Provider : 'xai');
  const [requestedStep, setStep] = useState(saved?.step ?? 0);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [modelId, setModelId] = useState(saved?.modelId ?? (model.model || PROVIDERS[initialProvider].model));
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? (model.baseUrl || ''));
  const [apiKey, setApiKey] = useState('');
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [verifiedRevision, setVerifiedRevision] = useState(saved?.verifiedRevision ?? null);
  const modelReady = verifiedRevision === revision;
  const step = requestedStep === 3 && !modelReady ? 2 : requestedStep === 3 && !status?.executionReady ? 1 : requestedStep;
  const credentialRef = provider === 'local' ? '' : (provider === model.provider && model.credentialRef && secretNames.includes(model.credentialRef) ? model.credentialRef : keyFor(provider));

  const setupJob = status?.setupJob;
  const setupRunning = setupJob?.state === 'running';

  useEffect(() => {
    writeProgress({ step: requestedStep, provider, modelId, baseUrl, verifiedRevision });
  }, [requestedStep, provider, modelId, baseUrl, verifiedRevision]);

  async function refresh() {
    setBusy('status'); setMessage('');
    try { setStatus(await readStatus(client)); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not check this computer.'); }
    finally { setBusy(''); }
  }

  useEffect(() => {
    let cancelled = false;
    readStatus(client).then(async value => {
      if (cancelled) return;
      setStatus(value);
      const names = value.credentialNames ?? (await client.request<{ secrets: string[] }>('/v1/health')).secrets;
      if (!cancelled) setSecretNames(names);
    }).catch(error => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not check this computer.');
    });
    return () => { cancelled = true; };
  }, [client]);

  // Rejoin a long setup after reload: POST returns immediately; status.setupJob is the source of truth.
  useEffect(() => {
    if (setupJob?.state !== 'running') return;
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      try {
        const next = await readStatus(client);
        if (cancelled) return;
        setStatus(next);
        if (next.setupJob?.state !== 'running') return;
      } catch {
        // Retry the status check without repeating the setup action.
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, setupJob?.state, setupJob?.action]);

  async function action(value: NonNullable<ReadinessCheck['action']>) {
    setBusy(value);
    setMessage('');
    try {
      const next = await client.request<OnboardingStatus>('/v1/onboarding/action', { method: 'POST', body: JSON.stringify({ action: value }) });
      setStatus(next);
    } catch (error) {
      // A lost reply can follow an accepted job. Rejoin it before offering a retry.
      const latest = await readStatus(client).catch(() => null);
      if (latest) setStatus(latest);
      if (!latest?.setupJob) setMessage(error instanceof Error ? error.message : 'Setup could not be completed.');
    } finally {
      setBusy('');
    }
  }

  async function saveModel() {
    if (!modelId.trim()) { setMessage('Choose or enter a model.'); return; }
    if (provider !== 'local' && !apiKey && !secretNames.includes(credentialRef)) { setMessage('Paste an API key, or choose a local model server.'); return; }
    setBusy('model'); setMessage('Saving and testing the connection…');
    const selected: ModelChoice = { provider, model: modelId.trim(), baseUrl: provider === 'local' ? baseUrl.trim() : '', credentialRef };
    try {
      if (apiKey && credentialRef) { await client.request('/v1/secrets', { method: 'POST', body: JSON.stringify({ name: credentialRef, value: apiKey, ...(status?.credentialMode === 'runner' ? { machineId: status.credentialMachineId } : {}) }) }); setSecretNames(current => [...new Set([...current, credentialRef])]); }
      const changedModel = model.provider !== selected.provider || model.model !== selected.model || model.baseUrl !== selected.baseUrl || model.credentialRef !== selected.credentialRef;
      const savedModel = changedModel
        ? await client.request<{ model: ModelChoice; revision: number }>('/v1/workspace/model', { method: 'PUT', body: JSON.stringify({ revision, model: selected }) })
        : { model, revision };
      if (changedModel) onModelSaved(savedModel.model, savedModel.revision);
      setApiKey('');
      setVerifiedRevision(null);
      const test = await client.request<{ ok: boolean; message: string }>('/v1/onboarding/model-test', { method: 'POST', body: JSON.stringify({ model: savedModel.model }) });
      setVerifiedRevision(test.ok ? savedModel.revision : null);
      if (test.ok) {
        setMessage('');
        setStep(3);
      } else setMessage(test.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the model connection.'); }
    finally { setBusy(''); }
  }

  function finish() {
    try { localStorage.removeItem(ONBOARDING_PROGRESS_KEY); } catch { /* private mode */ }
    onFinished();
  }

  const actionBusy = Boolean(busy) || setupRunning;
  const setupMessage = message || setupJob?.message || (setupRunning ? 'Setup is running in the background…' : '');

  return <div className="modal-backdrop onboarding-backdrop">
    <section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <header><div><div className="eyebrow">FIRST-RUN SETUP</div><h2 id="onboarding-title">{['Welcome to Open Harness', selfHosted ? 'Check this server' : 'Check this computer', 'Connect your model', 'You’re ready'][step]}</h2></div><button type="button" aria-label="Set up later" onClick={onDismiss}><X size={19} /></button></header>
      <div className="onboarding-progress" aria-label={`Step ${step + 1} of 4`}>{[0,1,2,3].map(item => <span className={item <= step ? 'active' : ''} key={item} />)}</div>

      {step === 0 && <div className="onboarding-step">
        <div className="onboarding-hero"><span><Sparkles size={26} /></span><h3>Your agents can keep working on {selfHosted ? 'this server' : 'a computer you control'}.</h3><p>Open Harness stores its data here. Tasks continue when you close the browser.</p></div>
        <button type="button" className="onboarding-choice" onClick={() => setStep(1)}><MonitorCog size={23} /><span><strong>{selfHosted ? 'Use this server' : 'Use this computer'}</strong><small>Recommended for your first agent. We’ll check everything for you.</small></span><ArrowRight size={18} /></button>
        {!selfHosted && <button type="button" className="onboarding-choice" onClick={() => { onDismiss(); onComputerSettings(); }}><Server size={23} /><span><strong>Connect another computer</strong><small>Pair a VPS, home server, Mac, Windows PC, or Linux machine.</small></span><ArrowRight size={18} /></button>}
      </div>}

      {step === 1 && <div className="onboarding-step">
        <p className="onboarding-lead">These checks stay on {selfHosted ? 'your server' : 'your computer'}. Open Harness will tell you what it can fix and give you a direct link for anything you need to install.</p>
        <div className="onboarding-checks">{status?.checks.map(check => <CheckRow key={check.id} check={check} busy={actionBusy} job={setupJob} onAction={action} />)}</div>
        {!status && !message && <p className="onboarding-working"><LoaderCircle className="spin" size={17} /> Checking this computer…</p>}
        {setupMessage && <p className={setupRunning ? 'onboarding-working' : 'onboarding-message'} role="status">{setupRunning && <LoaderCircle className="spin" size={17} />} {setupMessage}</p>}
        {status && !modelReady && !status.executionReady && <button type="button" className="onboarding-skip" onClick={() => { setMessage(''); setStep(2); }}>Connect my model while I finish this later</button>}
        <div className="onboarding-actions">
          {setupRunning ? <button type="button" className="light-button" onClick={onDismiss}>Continue setup later</button> : <>
            <button type="button" className="subtle-button" disabled={actionBusy} onClick={refresh}>Check again</button>
            <button type="button" className="light-button" disabled={!status?.executionReady || actionBusy} onClick={() => { setMessage(''); setStep(modelReady ? 3 : 2); }}>{modelReady ? 'Finish setup' : 'Continue'} <ArrowRight size={14} /></button>
          </>}
        </div>
      </div>}

      {step === 2 && <div className="onboarding-step">
        <p className="onboarding-lead">Use an API key from a model provider, or connect a compatible model server running on your network.</p>
        <label>Provider<select value={provider} disabled={Boolean(busy)} onChange={event => { const next = event.target.value as Provider; setProvider(next); setModelId(PROVIDERS[next].model); setBaseUrl(''); setApiKey(''); setVerifiedRevision(null); setMessage(''); }}>{Object.entries(PROVIDERS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></label>
        <label>Model<input value={modelId} disabled={Boolean(busy)} onChange={event => { setModelId(event.target.value); setVerifiedRevision(null); }} placeholder="Model ID" /></label>
        {provider === 'local' ? <label>Model server address<input value={baseUrl} disabled={Boolean(busy)} onChange={event => { setBaseUrl(event.target.value); setVerifiedRevision(null); }} placeholder="http://127.0.0.1:11434/v1" /><small>Enter the OpenAI-compatible API address shown by your model app.</small></label> : <label>API key<input type="password" value={apiKey} disabled={Boolean(busy)} onChange={event => { setApiKey(event.target.value); setVerifiedRevision(null); }} autoComplete="new-password" placeholder={secretNames.includes(credentialRef) ? 'A saved key is available — paste only to replace it' : 'Paste your API key'} /><small>{status?.credentialMode === 'runner' ? 'The key is encrypted for the connected computer and saved by its OS credential vault. The hosted coordinator cannot decrypt it.' : 'The key is stored on your coordinator and is only sent to runs that use it.'} <a href={providerHelp[provider]} target="_blank" rel="noreferrer">Get a key <ExternalLink size={11} /></a></small></label>}
        {message && <p className={`onboarding-message ${modelReady ? 'success' : ''}`} role="status">{message}</p>}
        <div className="onboarding-actions"><button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => { setMessage(''); setStep(1); }}><ArrowLeft size={14} /> Back</button><button type="button" className="light-button" disabled={busy === 'model'} onClick={saveModel}>{busy === 'model' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save and test</button></div>
      </div>}

      {step === 3 && <div className="onboarding-step onboarding-done">
        <span><Check size={34} /></span><h3>Open Harness is set up.</h3><p>Your first agent uses a private workspace on {selfHosted ? 'this server' : 'this computer'}. Advanced execution options remain available from Workspace settings.</p>
        <button type="button" className="light-button" onClick={finish}>Start using Open Harness <ArrowRight size={15} /></button>
        <button type="button" className="subtle-button" onClick={() => { finish(); onComputerSettings(); }}>Review computer settings</button>
      </div>}
      {step < 3 && <footer>Your setup is saved as you go. You can close this window and return from Workspace settings.</footer>}
    </section>
  </div>;
}
