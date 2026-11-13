import { test, expect, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';
import type { CredentialRecord } from '../../lib/credentials';

const control=`http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const account:CredentialRecord={ref:'CODEX_BROWSER_FIXTURE',label:'ChatGPT browser fixture',provider:'openai-codex',model:'',baseUrl:'',present:true,fingerprint:'fixture',length:100,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastUsedAt:null,usage:{uses:[],agentCount:0,activeRuns:0}};
async function navigate(page:Page,isMobile:boolean,name:string){if(isMobile)await page.getByRole('button',{name:'Open navigation'}).click();await page.locator('aside.sidebar').getByRole('button',{name,exact:true}).click();}

test.beforeEach(async({page,request})=>{
  const {token}=await(await request.get(control+'/v1/bootstrap')).json(),headers={Authorization:`Bearer ${token}`};
  await request.post(control+'/v1/agents/sync',{headers,data:{agents:initialWorkspace.agents}});
  const {profile}=await(await request.get(control+'/v1/agents/atlas/profile',{headers})).json();
  await request.put(control+'/v1/agents/atlas/profile',{headers,data:{...draftProfile(initialWorkspace.agents[0]),revision:profile.revision}});
  await page.addInitScript(()=>{localStorage.setItem('open-harness.onboarding.v1','done');localStorage.setItem('open-harness.advanced.v1','on');});
});

// Provider changes can leave a credential fetch running after the last UI assertion.
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'wait'});});

async function authFixture(page:Page){
  const state={connected:false,declined:false};
  await page.route('**/v1/credentials',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();const value=await response.json();return route.fulfill({json:{...value,credentials:[...value.credentials,...(state.connected?[account]:[])]}});});
  await page.route('**/v1/codex/auth',route=>route.fulfill({json:{id:'fixture-flow',authorizationUrl:'https://auth.openai.com/api/accounts/authorize?state=fixture-flow',callbackUrl:'http://127.0.0.1:4317/auth/callback',expiresAt:Date.now()+600000}}));
  await page.route('**/v1/codex/auth/fixture-flow',route=>route.fulfill({json:state.declined?{state:'error',message:'ChatGPT plan usage was not authorized.'}:state.connected?{state:'connected',credentialRef:account.ref,message:'ChatGPT is connected.'}:{state:'waiting'}}));
  await page.route('**/v1/models?**',route=>{const query=new URL(route.request().url()).searchParams;if(query.get('provider')!=='openai-codex')return route.continue();const connected=state.connected&&query.get('credentialRef')===account.ref;return route.fulfill({json:{models:connected?['fixture-codex-model']:[],error:connected?undefined:'Sign in with ChatGPT to load models for your account.'}});});
  return state;
}

test('credential store offers Codex sign-in without a pasted key and keeps the account selectable',async({page,isMobile})=>{
  const auth=await authFixture(page);await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button',{name:'Edit Atlas profile'})).toBeVisible();
  await navigate(page,isMobile,'Credentials');const repo=page.getByRole('region',{name:'Credentials'});
  await repo.getByRole('button',{name:'Add credential',exact:true}).click();const picker=page.getByRole('dialog',{name:'Add new credential'});
  await picker.getByRole('option',{name:/Codex/}).click();await picker.getByRole('button',{name:'Continue'}).click();const dialog=page.getByRole('dialog',{name:'New Codex (ChatGPT OAuth) credential'});
  await expect(dialog.getByLabel('Value',{exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();
  await expect(dialog.getByRole('link',{name:'Continue with ChatGPT'})).toHaveAttribute('href',/^https:\/\/auth.openai.com\//);
  auth.connected=true;await expect(dialog).toHaveCount(0);await expect(repo.getByText(account.label,{exact:true})).toBeVisible();
  await expect(repo.getByRole('button',{name:'Reconnect',exact:true})).toBeVisible();
  await expect(repo.getByRole('button',{name:'Replace',exact:true}).filter({hasText:'ChatGPT'})).toHaveCount(0);
});

test('ChatGPT sign-in explains a disconnected coordinator and can retry after reconnection',async({page,isMobile})=>{
  await authFixture(page);let offline=true;
  await page.route('**/v1/codex/auth',route=>offline?route.abort('connectionrefused'):route.fallback());
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button',{name:'Edit Atlas profile'})).toBeVisible();
  await navigate(page,isMobile,'Credentials');const repo=page.getByRole('region',{name:'Credentials'});
  await repo.getByRole('button',{name:'Add credential',exact:true}).click();const picker=page.getByRole('dialog',{name:'Add new credential'});
  await picker.getByRole('option',{name:/Codex/}).click();await picker.getByRole('button',{name:'Continue'}).click();const dialog=page.getByRole('dialog',{name:'New Codex (ChatGPT OAuth) credential'});
  const signIn=dialog.getByRole('button',{name:'Sign in with ChatGPT',exact:true});await signIn.click();
  await expect(dialog.getByRole('alert')).toContainText('Cannot reach the Open Harness coordinator.');await expect(signIn).toBeEnabled();
  offline=false;await signIn.click();
  await expect(dialog.getByRole('link',{name:'Continue with ChatGPT'})).toBeVisible();await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('workspace model chooses Codex OAuth, loads account models, and tests the selected sign-in',async({page,isMobile})=>{
  const auth=await authFixture(page);await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);await expect(page.getByRole('button',{name:'Edit Atlas profile'})).toBeVisible();
  if(isMobile)await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('button',{name:/Settings/}).first().click();
  const settings=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Workspace settings',exact:true})});await settings.getByRole('combobox',{name:'Provider',exact:true}).selectOption('openai-codex');
  await settings.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();auth.connected=true;
  await expect(settings.getByRole('button',{name:'Sign in with ChatGPT again',exact:true})).toBeVisible();
  await expect(settings.getByLabel('Available models')).toContainText('fixture-codex-model');await settings.getByLabel('Available models').selectOption('fixture-codex-model');
  const sent=page.waitForRequest(request=>request.url().endsWith('/v1/onboarding/model-test'));
  await page.route('**/v1/onboarding/model-test',route=>{const input=route.request().postDataJSON();return route.fulfill({json:{ok:true,message:'Fixture model completed.',model:input.model,revision:input.revision+1}});});
  await settings.getByRole('button',{name:'Save and test',exact:true}).click();expect((await sent).postDataJSON().model).toMatchObject({provider:'openai-codex',credentialRef:account.ref,model:'fixture-codex-model',baseUrl:''});
  await expect(settings).toBeHidden();
});

test('agent settings offer Codex OAuth and preserve a declined sign-in draft',async({page})=>{
  const auth=await authFixture(page);await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);await page.getByRole('button',{name:'Edit Atlas profile'}).click();
  const editor=page.getByRole('dialog',{name:'Agent settings'});await expect(editor.getByText('Loading saved profile…')).toBeHidden();await editor.getByRole('tab',{name:'Model',exact:true}).click();await editor.getByLabel('Use workspace default').uncheck();await editor.getByLabel('Provider',{exact:true}).selectOption('openai-codex');
  await editor.getByRole('combobox',{name:'Model',exact:true}).fill('my-unsaved-model');await editor.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();auth.declined=true;
  await expect(editor.getByRole('status').filter({hasText:'ChatGPT plan usage was not authorized.'})).toBeVisible();await expect(editor.getByRole('combobox',{name:'Model',exact:true})).toHaveValue('my-unsaved-model');await expect(editor.getByLabel('Provider',{exact:true})).toHaveValue('openai-codex');
});

test('first-run setup offers ChatGPT sign-in and no API-key field for Codex',async({page,isMobile})=>{
  await authFixture(page);await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);await expect(page.getByRole('button',{name:'Edit Atlas profile'})).toBeVisible();
  if(isMobile)await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('button',{name:/Settings/}).first().click();await page.getByRole('button',{name:'Run setup again'}).click();await page.getByRole('button',{name:/Use this computer/}).click();
  await page.route('**/v1/onboarding/status',route=>route.fulfill({json:{executionReady:true,checks:[],credentialNames:[]}}));
  await page.getByRole('button',{name:'Check again'}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
  const setup=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Connect your model',exact:true})});await setup.getByRole('combobox',{name:'Provider',exact:true}).selectOption('openai-codex');await expect(setup.getByRole('button',{name:'Sign in with ChatGPT',exact:true})).toBeVisible();await expect(setup.getByLabel('API key',{exact:true})).toHaveCount(0);
});
