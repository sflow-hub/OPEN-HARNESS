// Actual production UI, no route/request mocks. Input contains private auth; never log it.
import assert from 'node:assert/strict';
import {chmodSync,existsSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const fields = Object.freeze({name:'Name',description:'Short description',prompt:'System prompt / agent instructions'});
export const KINDS = Object.freeze(['MAIN','DENY','APPROVE']);
// Parent acknowledgements are private files in its 0700 handshake directory, not product endpoints. The parent's
// checks start Docker helpers, so the wait is generous; it bounds only the parent, never the product.
export async function awaitParent(handshake,name,ms=60000) {
  const until=Date.now()+ms;
  while(!existsSync(join(handshake,name))){assert.ok(Date.now()<until,`Parent did not acknowledge ${name}`);await new Promise(r=>setTimeout(r,50));}
}
export const redact=text=>String(text).replace(/#pair=[^\s'"`)]*/g,'#pair=[redacted]').slice(0,2000);
export async function browserPhase(spec) {
  const api=async path=>{const r=await fetch(spec.api+path,{headers:{Authorization:`Bearer ${spec.token}`},signal:AbortSignal.timeout(15000)});assert.ok(r.ok,`GET ${path}: ${r.status}`);return r.json();};
  const emit=value=>process.stdout.write(JSON.stringify({...value,stage:spec.stage})+'\n');
  let browser,expect,context,page,step='launch';
  const card=()=>page.locator('button.agent-card').filter({has:page.getByRole('heading',{name:'Upgrade Alpha',exact:true})});
  const reply=text=>page.locator('.message.assistant').filter({hasText:text}).last();
  try {
    const require=createRequire(join(spec.dependencies,'package.json')),playwright=require('@playwright/test');expect=playwright.expect;
    browser=await playwright.chromium.launch({executablePath:spec.chromiumExecutable,headless:true});
    context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>{localStorage.setItem('open-harness.onboarding.v1','done');localStorage.setItem('open-harness.advanced.v1','on');});
    page=await context.newPage();step='open';
    // Like the launcher's one-use link, the first document load carries the pairing code.
    await page.goto(spec.pairCode?`${spec.url}#pair=${encodeURIComponent(spec.pairCode)}`:spec.url,{waitUntil:'networkidle',timeout:60000});
    if (spec.pairCode) await expect(page).not.toHaveURL(/#pair=/,{timeout:30000});
    step='profile';
    const agents=page.getByRole('button',{name:/^Agents(?:\s|$)/});if(await agents.count())await agents.first().click();
    await page.getByRole('button',{name:'Edit Upgrade Alpha profile',exact:true}).click({timeout:60000});
    const dialog=page.getByRole('dialog',{name:'Agent settings',exact:true});
    for (const [field,value] of [[fields.name,'Upgrade Alpha'],[fields.description,'Historical revision three']]) await expect(dialog.getByRole('textbox',{name:field,exact:true})).toHaveValue(value);
    await dialog.getByRole('tab',{name:'System prompt',exact:true}).click();
    await expect(dialog.getByRole('textbox',{name:fields.prompt,exact:true})).toHaveValue('Work only on the synthetic upgrade fixture.');
    await dialog.getByRole('button',{name:'Close agent settings',exact:true}).click();
    step='history';let history='not applicable: first stage';
    if (spec.stage === 'UPGRADED') {
      // The current UI rebuilds conversations from the coordinator after connecting, newest first. Wait for
      // that rebuild before opening the agent, then every baseline conversation must reopen with its reply.
      await expect(page.getByRole('button',{name:/^UPGRADE_APPROVE_BASELINE:/})).toBeVisible({timeout:60000});
      await card().click();await expect(reply('REAL_UPGRADE_APPROVE_BASELINE_COMPLETE')).toBeVisible({timeout:60000});
      for (const kind of KINDS) {await page.getByRole('button',{name:new RegExp(`^UPGRADE_${kind}_BASELINE:`)}).click();await expect(reply(`REAL_UPGRADE_${kind}_BASELINE_COMPLETE`)).toBeVisible({timeout:30000});}
      history='every baseline conversation reopened from coordinator history';
    } else {
      await card().click();
      if (spec.stage === 'ROLLBACK') history='not asserted in the UI: original0.3 keeps conversations in browser storage, so a new browser shows none; the parent asserts retained server history';
    }
    const results=[];
    for (const kind of KINDS) {
      step=`job:${kind}`;emit({event:'before-job',kind});
      // The parent resets the fixture proof file through its own state helper before an approval job.
      if (kind !== 'MAIN') await awaitParent(spec.handshake,`${kind}.ready`);
      const fresh=page.getByRole('button',{name:'New conversation',exact:true});if(await fresh.count())await fresh.click();
      const prompt=`UPGRADE_${kind}_${spec.stage}: Perform only this synthetic fixture job.`;
      const before=new Set((await api('/v1/runs')).runs.map(r=>r.id));
      const composer=page.getByRole('textbox',{name:'Message Upgrade Alpha',exact:true});await composer.fill(prompt);await composer.press('Enter');
      const deadline=Date.now()+180000;let completed,runId;const inputIds=new Set(),approvalIds=new Set();
      while(Date.now()<deadline) {
        const run=(await api('/v1/runs')).runs.find(r=>!before.has(r.id)&&r.agent_id==='upgrade-alpha'&&r.prompt===prompt);
        if(run){
          runId=run.id;const snapshot=await api(`/v1/runs/${run.id}/events?after=0`);
          for(const pending of snapshot.run.pendingInputs||[]) if(!inputIds.has(pending.inputId)) {
            assert.equal(spec.stage,'UPGRADED','Original0.3 has no input response route');assert.equal(kind,'MAIN','Only the main job asks for input');
            await page.getByRole('textbox',{name:'Your answer',exact:true}).fill('upgrade-answer');await page.getByRole('button',{name:'Send answer',exact:true}).click();inputIds.add(pending.inputId);
          }
          for(const event of snapshot.events.filter(e=>e.type==='approval.request')) if(!approvalIds.has(event.payload.approvalId)) {
            assert.ok(kind==='DENY'||kind==='APPROVE',`Unexpected approval request in the ${kind} job`);
            emit({event:'approval-pending',kind,runId:run.id});await awaitParent(spec.handshake,`${kind}.pending`);
            await page.getByRole('button',{name:kind==='DENY'?'Deny':'Approve once',exact:true}).click();approvalIds.add(event.payload.approvalId);
          }
          if(['completed','failed','cancelled','interrupted'].includes(snapshot.run.state)){assert.equal(snapshot.run.state,'completed',`The ${kind} job ended ${snapshot.run.state}: ${redact(snapshot.run.error||'')}`);completed=snapshot;break;}
        }
        await new Promise(r=>setTimeout(r,150));
      }
      assert.ok(completed,`The ${kind} job did not complete in time${runId?'':'; the composer created no run'}`);
      assert.equal(inputIds.size,kind==='MAIN'&&spec.stage==='UPGRADED'?1:0,`The ${kind} job must answer exactly its own clarification through the UI`);
      assert.equal(approvalIds.size,kind!=='MAIN'?1:0,`The ${kind} job must resolve exactly its own approval through the UI`);
      await expect(reply(`REAL_UPGRADE_${kind}_${spec.stage}_COMPLETE`)).toBeVisible({timeout:30000});
      results.push({kind,runId:completed.run.id,inputIds:inputIds.size,approvalIds:approvalIds.size});
      emit({event:'after-job',kind,runId:completed.run.id});await awaitParent(spec.handshake,`${kind}.checked`);
    }
    // Closing the tab must not erase server history or its browser pairing.
    step='reopen';await page.close();page=await context.newPage();await page.goto(spec.url,{waitUntil:'networkidle',timeout:60000});
    await card().click();await expect(reply(`REAL_UPGRADE_APPROVE_${spec.stage}_COMPLETE`)).toBeVisible({timeout:60000});
    await page.reload({waitUntil:'networkidle',timeout:60000});
    if(await card().isVisible())await card().click();
    await expect(reply(`REAL_UPGRADE_APPROVE_${spec.stage}_COMPLETE`)).toBeVisible({timeout:60000});
    return {ok:true,stage:spec.stage,profileVisible:true,history,realComposerAndApprovalUI:true,browserCloseAndReloadPersistence:true,pairing:!!spec.pairCode,browserVersion:browser.version(),results};
  } catch (error) {
    // Private record for diagnosis in the parent's 0700 handshake directory: no token, pairing code or request data.
    try {
      const base=join(spec.handshake,`failure-${String(spec.stage).toLowerCase()}`);
      writeFileSync(base+'.json',JSON.stringify({stage:spec.stage,step,name:error?.name,message:redact(error?.message)},null,2)+'\n',{mode:0o600});
      if(page&&!page.isClosed()){writeFileSync(base+'.aria.txt',redact(await page.locator('body').ariaSnapshot({timeout:5000})),{mode:0o600});await page.screenshot({path:base+'.png',timeout:5000});chmodSync(base+'.png',0o600);}
    } catch {}
    throw error;
  } finally {await context?.close();await browser?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){let raw='';for await(const c of process.stdin)raw+=c;try{console.log(JSON.stringify({event:'result',result:await browserPhase(JSON.parse(raw))}));}catch(e){console.error(`${e.name}: browser phase failed; private diagnostics are in the handshake directory`);process.exitCode=1;}}
