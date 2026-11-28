'use client';

import { useEffect, useState } from 'react';
import { ControlClient } from '../../lib/control-client';

// This page belongs to the shipped dashboard and is outside the editable source.
export default function LocalEdition() {
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const home = new URL(location.href); home.pathname='/';
    const load = async () => {
      const client = new ControlClient();
      if (client.managed || home.searchParams.get('original')==='1') { location.replace(home.href); return; }
      const status = await client.bootstrap();
      if (!current) return;
      if (!status.localDashboardRevision) { location.replace(home.href); return; }
      const {html} = await client.request<{html:string}>(`/v1/local-improvements/${status.localDashboardRevision}/active`);
      if (!current) return;
      document.open(); document.write(html); document.close();
    };
    void load().catch(e=>{if(current) setError(e instanceof Error ? e.message : 'The local dashboard could not open.');});
    return () => { current=false; };
  },[]);
  return <main><h1>Opening your local dashboard</h1>{error && <p role="alert">{error}</p>}<button type="button" onClick={() => {
    const url = new URL(location.href); url.pathname='/'; url.searchParams.set('original','1'); location.assign(url.href);
  }}>Open original dashboard</button></main>;
}
