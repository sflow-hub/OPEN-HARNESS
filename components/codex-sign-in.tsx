'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import type { ControlClient } from '../lib/control-client';
import type { CodexAuthStart, CodexAuthStatus } from '../lib/codex';
import { CODEX_PROVIDER } from '../lib/codex';
import type { CredentialRecord } from '../lib/credentials';

export default function CodexSignIn({ client, credentialRef = '', onConnected, allowAccountSelection = true }: { client: ControlClient; credentialRef?: string; onConnected: (ref: string) => void; allowAccountSelection?: boolean }) {
  const [attempt,setAttempt] = useState<CodexAuthStart | null>(null), [state,setState] = useState<CodexAuthStatus | null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [callback,setCallback] = useState('');
  const [accounts,setAccounts] = useState<CredentialRecord[]>([]);
  const connected = useRef(onConnected); useEffect(()=>{connected.current=onConnected;},[onConnected]);
  useEffect(()=>{let live=true;void client.request<{credentials:CredentialRecord[]}>('/v1/credentials').then(value=>{if(live)setAccounts(value.credentials.filter(item=>item.provider===CODEX_PROVIDER));},()=>{});return()=>{live=false;};},[client,credentialRef]);
  useEffect(()=>{
    if (!attempt) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const value = await client.request<CodexAuthStatus>(`/v1/codex/auth/${attempt.id}`);
        if (!live) return; setState(value);
        if (value.state === 'connected' && value.credentialRef) { connected.current(value.credentialRef); setAttempt(null); setCallback(''); return; }
        if (value.state === 'error') return;
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'Could not check sign-in.'); return; }
      if (live) timer = setTimeout(check,1500);
    };
    void check(); return ()=>{live=false;clearTimeout(timer);};
  },[attempt,client]);
  async function start() {
    setBusy(true); setError(''); setState(null); setCallback('');
    try { setAttempt(await client.request<CodexAuthStart>('/v1/codex/auth',{method:'POST',body:JSON.stringify({credentialRef})})); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start ChatGPT sign-in.'); }
    finally { setBusy(false); }
  }
  return <div className="profile-advanced codex-sign-in">
    <p className="profile-help">Use your ChatGPT account for model access. Your plan&rsquo;s available models and usage limits apply. Open Harness keeps this sign-in on the coordinator; account tokens are never returned to this page or sent to agents.</p>
    {allowAccountSelection && accounts.length > 0 && <label>ChatGPT account<select value={credentialRef} onChange={event=>onConnected(event.target.value)}><option value="">Choose an account</option>{accounts.map(account=><option key={account.ref} value={account.ref}>{account.label}{account.present?'':' — sign in again'}</option>)}</select></label>}
    <button type="button" className="subtle-button" disabled={busy} onClick={()=>void start()}>{busy && <LoaderCircle size={14} className="spin" />}{credentialRef ? 'Sign in with ChatGPT again' : 'Sign in with ChatGPT'}</button>
    {attempt && state?.state !== 'error' && <>
      <p><a className="light-button" data-oai-siwc-button href={attempt.authorizationUrl} target="_blank" rel="noreferrer">Continue with ChatGPT <ExternalLink size={14} /></a></p>
      <p role="status">Waiting for authorization. Finish sign-in in the new tab, then return here.</p>
      <details><summary>Signing in from another computer or VM?</summary><p className="profile-help">The callback uses {attempt.callbackUrl}. If that page cannot connect after sign-in, copy its full address from the browser and paste it here. This address contains a one-time authorization code; keep it private.</p><label>Sign-in callback URL<input type="password" autoComplete="off" value={callback} onChange={event=>setCallback(event.target.value)} /></label><button type="button" className="subtle-button" disabled={busy || !callback.trim()} onClick={async()=>{setBusy(true);setError('');try {const result=await client.request<CodexAuthStatus>(`/v1/codex/auth/${attempt.id}/complete`,{method:'POST',body:JSON.stringify({callbackUrl:callback})});setState(result);if(result.credentialRef){connected.current(result.credentialRef);setAttempt(null);setCallback('');}}catch(cause){setError(cause instanceof Error?cause.message:'Could not complete sign-in.');}finally{setBusy(false);}}}>Complete sign-in</button></details>
    </>}
    {state?.message && <p role="status" className="profile-help">{state.message}</p>}
    {error && <p role="alert" className="computer-warning">{error}</p>}
  </div>;
}
