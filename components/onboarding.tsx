'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ExternalLink, LoaderCircle, MonitorCog, Server, Sparkles, X } from 'lucide-react';
import { BUNDLED_MODEL, type ModelChoice } from '../lib/agent-profile';
import { ControlClient } from '../lib/control-client';
import type { OnboardingStatus, ReadinessCheck } from '../lib/onboarding';
import { PROVIDERS, type Provider } from '../lib/provider';
import ModelPicker from './model-picker';
import { CODEX_PROVIDER } from '../lib/codex';
import type { SetupJob } from '../lib/product';

/** Non-secret wizard draft. Cleared when setup finishes; kept on “Set up later”. */
const progressKey = (scope: string) => `open-harness.onboarding.progress.v1:${encodeURIComponent(scope)}`;

type Props = {
  client: ControlClient;
  model: ModelChoice;
  revision: number;
  launcherModel?: 'local' | 'provider';
  onModelSaved: (model: ModelChoice, revision: number) => void;
  onComputerSettings: () => void;
  onDismiss: () => void;
  onFinished: () => void;
  // The guide's checks and set-up actions change what the coordinator reports as the
  // runtime state; the parent re-reads that state when told a fresh answer exists.
  onRuntimeChecked?: (status: OnboardingStatus) => void;
};

type Progress = {
  step: number;
  provider: Provider;
  modelId: string;
  baseUrl: string;
  localChoice: boolean | null;
  codexRef: string;
  verifiedRevision: number | null;
};

const keyFor = (provider: string) => ({ xai: 'XAI_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as Record<string,string>)[provider] || '';
const providerHelp = { xai: 'https://console.x.ai/', openai: 'https://platform.openai.com/api-keys', openrouter: 'https://openrouter.ai/settings/keys' } as Record<string,string>;

function readProgress(scope: string | null): Progress | null {
  if (!scope || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(progressKey(scope));
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
      localChoice: typeof value.localChoice === 'boolean' ? value.localChoice : null,
      codexRef: typeof value.codexRef === 'string' ? value.codexRef : '',
      verifiedRevision: typeof value.verifiedRevision === 'number' ? value.verifiedRevision : null,
    };
  } catch {
    return null;
  }
}

export function hasOnboardingProgress(scope: string | null) {
  return readProgress(scope) !== null;
}

function writeProgress(scope: string | null, progress: Progress) {
  if (!scope) return;
  // A pasted endpoint can contain credentials before the form validates it.
  let baseUrl = '';
  try {
    const url = new URL(progress.baseUrl);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) baseUrl = progress.baseUrl;
  } catch { /* keep unfinished addresses in memory */ }
  try { localStorage.setItem(progressKey(scope), JSON.stringify({ ...progress, baseUrl })); } catch { /* private mode */ }
}

function jobForCheck(jobs: SetupJob[], check: ReadinessCheck) {
  if (!check.action) return undefined;
  return jobs.find(job => job.kind === check.action);
}

function CheckRow({ check, busy, job, onAction }: {
  check: ReadinessCheck;
  busy: boolean;
  job?: SetupJob;
  onAction: (action: NonNullable<ReadinessCheck['action']>) => void;
}) {
  const jobBusy = Boolean(job && ['queued', 'running'].includes(job.state));
  const jobFailed = Boolean(job && ['failed', 'interrupted'].includes(job.state));
  return <div className={`onboarding-check ${jobFailed ? 'action' : check.state}`}>
    <span className="onboarding-check-icon" aria-hidden="true">{check.state === 'ready' && !jobFailed ? <Check size={17} /> : check.state === 'unavailable' ? <span>—</span> : <CircleAlert size={17} />}</span>
    <div><strong>{check.label}</strong><small>{check.detail}</small></div>
    {check.action && <button type="button" className="subtle-button" disabled={busy || jobBusy} onClick={() => onAction(check.action!)}>
      {jobBusy ? <LoaderCircle className="spin" size={14} /> : null}
      {jobBusy ? 'Working…' : jobFailed ? 'Try again' : check.actionLabel}
    </button>}
    {check.helpUrl && <a className="subtle-button" href={check.helpUrl} target="_blank" rel="noreferrer">Install <ExternalLink size={13} /></a>}
  </div>;
}

const selfHosted = process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1';

export default function Onboarding({ client, model, revision, launcherModel, onModelSaved, onComputerSettings, onDismiss, onFinished, onRuntimeChecked }: Props) {
  const scope = client.draftScope;
  const [saved] = useState(() => launcherModel ? null : readProgress(scope));
  const changingToProvider = launcherModel === 'provider';
  const initialProvider = saved?.provider ?? (!changingToProvider && Object.hasOwn(PROVIDERS, model.provider) ? model.provider as Provider : 'xai');
  const [requestedStep, setStep] = useState(launcherModel ? 2 : saved?.step === 2 && saved.verifiedRevision !== null ? 3 : saved?.step ?? 0);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [modelId, setModelId] = useState(saved?.modelId ?? ((changingToProvider ? '' : model.model) || PROVIDERS[initialProvider].model));
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? (changingToProvider ? '' : model.baseUrl || ''));
  const [localChoice, setLocalChoice] = useState<boolean | null>(launcherModel ? launcherModel === 'local' : saved?.localChoice ?? null);
  const bundled = localChoice ?? Boolean(status?.bundledModelAvailable && (revision === 0 || (model.provider === 'local' && model.baseUrl === BUNDLED_MODEL.baseUrl && model.model === BUNDLED_MODEL.model)));
  const [apiKey, setApiKey] = useState('');
  const [codexRef,setCodexRef] = useState(saved?.codexRef ?? (model.provider === CODEX_PROVIDER ? model.credentialRef : ''));
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [verifiedRevision, setVerifiedRevision] = useState<number | null>(saved?.verifiedRevision ?? null);
  const modelReady = verifiedRevision === revision;
  const [jobs, setJobs] = useState<SetupJob[]>([]), [taskVerified, setTaskVerified] = useState(false);
  // Restore the first unfinished step: model check before verify, computer checks before model.
  const step = requestedStep === 3 && !modelReady ? 2 : requestedStep === 3 && !status?.executionReady ? 1 : requestedStep;
  const setupRunning = jobs.some(job => job.kind !== 'verify-task' && ['queued', 'running'].includes(job.state));
  const checkedCallback=useRef(onRuntimeChecked),lastReady=useRef<boolean|null>(null);
  useEffect(()=>{checkedCallback.current=onRuntimeChecked;},[onRuntimeChecked]);
  useEffect(() => {
    if (launcherModel) return;
    writeProgress(scope, { step: requestedStep, provider, modelId, baseUrl, localChoice, codexRef, verifiedRevision });
  }, [scope, launcherModel, requestedStep, provider, modelId, baseUrl, localChoice, codexRef, verifiedRevision]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try { const value = await client.request<OnboardingStatus & { setupJobs: SetupJob[]; taskVerified: boolean }>('/v1/readiness'); if (live) { setStatus(value); setJobs(value.setupJobs || []); setTaskVerified(Boolean(value.taskVerified));if(lastReady.current!==value.executionReady){lastReady.current=value.executionReady;checkedCallback.current?.(value);} } } catch { /* The explicit refresh and setup actions report connection failures. */ }
      if (live) timer = setTimeout(check, 2500);
    };
    void check(); return () => { live = false; clearTimeout(timer); };
  }, [client]);

  async function refresh() {
    setBusy('status'); setMessage('');
    try { const value = await client.request<OnboardingStatus>('/v1/onboarding/status'); setStatus(value); onRuntimeChecked?.(value); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not check this computer.'); }
    finally { setBusy(''); }
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([client.request<OnboardingStatus>('/v1/onboarding/status'), client.request<{ secrets: string[] }>('/v1/health')]).then(([value, health]) => { if (!cancelled) { setStatus(value); setSecretNames(value.credentialNames || health.secrets); } }, error => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not check this computer.'); });
    return () => { cancelled = true; };
  }, [client]);

  async function action(value: NonNullable<ReadinessCheck['action']>) {
    const latest = jobs.find(job => job.kind === value);
    if (busy || (latest && ['queued', 'running'].includes(latest.state))) return;
    const resume = latest && ['failed', 'interrupted'].includes(latest.state);
    setBusy(value); setMessage(value === 'prepare-runtime' ? 'Preparing the agent runtime. Progress is saved; you can return to setup later.' : 'Starting Docker…');
    try {
      const job = resume
        ? await client.request<SetupJob>(`/v1/setup/jobs/${latest.id}/resume`, { method: 'POST', body: '{}' })
        : await client.request<SetupJob>('/v1/setup/jobs', { method: 'POST', body: JSON.stringify({ kind: value }) });
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      setMessage('');
    }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Setup could not be completed.'); }
    finally { setBusy(''); }
  }

  function editProviderModel() {
    setLocalChoice(false);
    setVerifiedRevision(null);
    setMessage('');
  }

  const savedKeyFor = (candidate: Provider) => candidate === model.provider && model.credentialRef ? model.credentialRef : keyFor(candidate);
  async function saveModel() {
    if (modelReady) { setMessage(''); setStep(3); return; }
    const credentialRef = provider === CODEX_PROVIDER ? codexRef : provider === 'local' ? '' : savedKeyFor(provider);
    const selected: ModelChoice = bundled ? BUNDLED_MODEL : { provider, model: modelId.trim(), baseUrl: provider === 'local' ? baseUrl.trim() : '', credentialRef };
    if (!selected.model) { setMessage('Choose or enter a model.'); return; }
    if (selected.provider === CODEX_PROVIDER && !codexRef) { setMessage('Sign in with ChatGPT before saving this provider.'); return; }
    if (selected.provider !== CODEX_PROVIDER && selected.provider !== 'local' && !apiKey && !secretNames.includes(credentialRef)) { setMessage('Paste an API key, or choose a local model server.'); return; }
    setLocalChoice(bundled);
    setBusy('model'); setMessage('Saving and testing the connection…');
    try {
      const test = await client.request<{ ok: boolean; message: string; model?: ModelChoice; revision?: number }>('/v1/onboarding/model-test', { method: 'POST', body: JSON.stringify({ model: selected, apiKey: bundled || provider === CODEX_PROVIDER ? undefined : apiKey || undefined, save: true, revision }) });
      if (!test.ok || !test.model) { setVerifiedRevision(null); setMessage(`${test.message} Your previous workspace model is still active.`); return; }
      if (test.model.credentialRef) setSecretNames(current => [...new Set([...current, test.model!.credentialRef])]);
      const nextRevision = test.revision ?? revision;
      onModelSaved(test.model, nextRevision); setApiKey(''); setVerifiedRevision(nextRevision);
      if (status?.executionReady) {
        setMessage(test.message);
        setStep(3);
      } else {
        setMessage('Model connection is ready. Finish preparing the server before setup can complete.');
      }
    } catch (error) { setVerifiedRevision(null); setMessage(error instanceof Error ? error.message : 'Could not save the model connection.'); }
    finally { setBusy(''); }
  }

  function finish() {
    if (scope && !launcherModel) {
      try { localStorage.removeItem(progressKey(scope)); } catch { /* private mode */ }
    }
    onFinished();
  }

  const actionBusy = Boolean(busy) || setupRunning;
  const visibleJobs = jobs.filter(job => job.kind !== 'verify-task' && (!['failed','interrupted'].includes(job.state) || !status || status.checks.some(check => check.action === job.kind))).slice(0, 3);
  const title = ['Welcome to Open Harness', selfHosted ? 'Check this server' : 'Check this computer', 'Connect your model', taskVerified ? 'You’re ready' : 'Verify a task'][step];
  return <div className="modal-backdrop onboarding-backdrop">
    <section className="onboarding" role="dialog" aria-modal="true" aria-label={title} aria-labelledby="onboarding-title">
      <header><div><div className="eyebrow">{launcherModel ? 'WORKSPACE MODEL' : 'FIRST-RUN SETUP'}</div><h2 id="onboarding-title">{title}</h2></div>{(!launcherModel || modelReady) && <button type="button" aria-label="Set up later" onClick={onDismiss}><X size={19} /></button>}</header>
      <div className="onboarding-progress" aria-label={`Step ${step + 1} of 4`}>{[0,1,2,3].map(item => <span className={item <= step ? 'active' : ''} key={item} />)}</div>

      {step === 0 && <div className="onboarding-step">
        <div className="onboarding-hero"><span><Sparkles size={26} /></span><h3>Your agents can keep working on {selfHosted ? 'this server' : 'a computer you control'}.</h3><p>Open Harness stores its data here. Tasks continue when you close the browser.</p></div>
        <button type="button" className="onboarding-choice" onClick={() => setStep(1)}><MonitorCog size={23} /><span><strong>{selfHosted ? 'Use this server' : 'Use this computer'}</strong><small>Recommended for your first agent. We’ll check everything for you.</small></span><ArrowRight size={18} /></button>
        {!selfHosted && <button type="button" className="onboarding-choice" onClick={onComputerSettings}><Server size={23} /><span><strong>Connect another computer</strong><small>Pair a VPS, home server, Mac, Windows PC, or Linux machine.</small></span><ArrowRight size={18} /></button>}
      </div>}

      {step === 1 && <div className="onboarding-step">
        <p className="onboarding-lead">These checks stay on {selfHosted ? 'your server' : 'your computer'}. Open Harness will tell you what it can fix and give you a direct link for anything you need to install.</p>
        <div className="onboarding-checks">{status?.checks.map(check => <CheckRow key={check.id} check={check} busy={actionBusy} job={jobForCheck(jobs, check)} onAction={action} />)}</div>
        {visibleJobs.map(job => <div key={job.id}><p role="status">{job.detail}</p>{['interrupted','failed'].includes(job.state) && <button disabled={Boolean(busy)} onClick={() => { if (job.kind !== 'verify-task') void action(job.kind); }}>Resume setup</button>}</div>)}
        {!status && !message && <p className="onboarding-working"><LoaderCircle className="spin" size={17} /> Checking this computer…</p>}
        {message && <p className={setupRunning ? 'onboarding-working' : 'onboarding-message'} role="status">{setupRunning && <LoaderCircle className="spin" size={17} />} {message}</p>}
        {status && !modelReady && !status.executionReady && <button type="button" className="onboarding-skip" onClick={() => { setMessage(''); setStep(2); }}>Connect my model while I finish this later</button>}
        <div className="onboarding-actions">
          {setupRunning ? <button type="button" className="light-button" onClick={onDismiss}>Continue setup later</button> : <>
            <button type="button" className="subtle-button" disabled={actionBusy} onClick={refresh}>Check again</button>
            <button type="button" className="light-button" disabled={!status?.executionReady || actionBusy} onClick={() => { setMessage(''); setStep(modelReady ? 3 : 2); }}>{modelReady ? 'Finish setup' : 'Continue'} <ArrowRight size={14} /></button>
          </>}
        </div>
      </div>}

      {step === 2 && <div className="onboarding-step">
        {launcherModel && !modelReady && <p className="onboarding-lead">Your workspace currently uses <strong>{model.model}</strong>. Save and test to switch the model for agents using the workspace default.</p>}
        {bundled ? <>
          <h3>Use the model on this computer</h3>
          <p className="onboarding-lead">Atlas will use Qwen on your Linux computer. No account or API key is needed.</p>
          {status && !status.bundledModelAvailable && <p role="status">Open the Linux launcher and start the on-device model to use it here.</p>}
          <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={editProviderModel}>Choose another model</button>
        </> : <>
          {status?.bundledModelAvailable && <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => { setLocalChoice(true); setVerifiedRevision(null); setMessage(''); }}>Use the model on this computer</button>}
          <p className="onboarding-lead">Sign in with ChatGPT, use a provider API key, or connect a compatible model server on your network.</p>
          <label>Provider<select value={provider} disabled={Boolean(busy)} onChange={event => { const next = event.target.value as Provider; setProvider(next); setApiKey(''); setModelId(PROVIDERS[next].model); setBaseUrl(''); editProviderModel(); }}>{Object.entries(PROVIDERS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></label>
          <ModelPicker client={client} provider={provider === CODEX_PROVIDER ? provider : provider === 'local' ? (baseUrl.trim() ? provider : '') : (apiKey && status?.credentialMode !== 'runner') || secretNames.includes(savedKeyFor(provider)) ? provider : ''} credentialRef={provider === CODEX_PROVIDER ? codexRef : provider === 'local' ? '' : savedKeyFor(provider)} onCredentialChange={ref => { setCodexRef(ref); editProviderModel(); }} apiKey={status?.credentialMode === 'runner' ? '' : apiKey} baseUrl={provider === 'local' ? baseUrl.trim() : ''} value={modelId} onChange={value => { setModelId(value); editProviderModel(); }} />
          {provider !== CODEX_PROVIDER && (provider === 'local' ? <label>Model server address<input value={baseUrl} disabled={Boolean(busy)} onChange={event => { setBaseUrl(event.target.value); editProviderModel(); }} placeholder={selfHosted ? 'https://models.example.com/v1' : 'http://127.0.0.1:11434/v1'} /><small>{selfHosted ? 'Enter an OpenAI-compatible API address that the coordinator and the agent containers can reach over the network. localhost, 127.0.0.1 and host.docker.internal on this computer are refused here.' : 'Enter the OpenAI-compatible API address shown by your model app.'}</small></label> : <label>API key<input type="password" value={apiKey} disabled={Boolean(busy)} onChange={event => { setApiKey(event.target.value); editProviderModel(); }} autoComplete="new-password" placeholder={secretNames.includes(savedKeyFor(provider)) ? 'A saved key is available — paste only to replace it' : 'Paste your API key'} /><small>{status?.credentialMode === 'runner' ? 'The key is encrypted for the connected computer and saved by its OS credential vault. The hosted coordinator cannot decrypt it.' : 'The key is stored on your coordinator and is only sent to runs that use it.'} <a href={providerHelp[provider]} target="_blank" rel="noreferrer">Get a key <ExternalLink size={11} /></a></small></label>)}
        </>}
        {message && <p className={`onboarding-message ${modelReady ? 'success' : ''}`} role="status">{message}</p>}
        <div className="onboarding-actions">{launcherModel && !modelReady ? <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={onDismiss}>Keep current model</button> : <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => { setMessage(''); setStep(1); }}><ArrowLeft size={14} /> Back</button>}<button type="button" className="light-button" disabled={busy === 'model' || (bundled && !status?.bundledModelAvailable)} onClick={saveModel}>{busy === 'model' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {modelReady ? 'Continue' : 'Save and test'}</button></div>
      </div>}

      {step === 3 && <div className="onboarding-step onboarding-done">
        <span>{taskVerified ? <Check size={34} /> : <Sparkles size={34} />}</span><h3>{taskVerified ? 'Open Harness is set up.' : 'Check that real work completes.'}</h3><p>{taskVerified ? 'Your agent wrote a file and Open Harness independently read back the expected contents.' : 'Run a small model task that writes a unique file. Setup completes only after independent readback confirms the contents.'}</p>
        {jobs.filter(job => job.kind === 'verify-task').slice(0, 2).map(job => <p key={job.id} role="status">{job.detail}</p>)}
        {!taskVerified && <button type="button" className="light-button" disabled={Boolean(busy) || jobs.some(job => job.kind === 'verify-task' && ['queued','running'].includes(job.state))} onClick={() => { setBusy('verify-task'); void client.request<SetupJob>('/v1/setup/jobs', { method: 'POST', body: JSON.stringify({ kind: 'verify-task' }) }).then(job => setJobs(current => [job, ...current])).catch(error => setMessage(error.message)).finally(() => setBusy('')); }}>Run verification task</button>}
        {message && <p role="status">{message}</p>}
        <button type="button" className="light-button" disabled={!taskVerified} onClick={finish}>Start using Open Harness <ArrowRight size={15} /></button>
        <button type="button" className="subtle-button" onClick={onComputerSettings}>Review computer settings</button>
      </div>}
      {step < 3 && <footer>Your setup is saved as you go. You can close this window and return from Workspace settings.</footer>}
    </section>
  </div>;
}
