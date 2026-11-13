import { createHmac } from 'node:crypto';
import type { Store } from './db';
import { ProductError } from './product-error';
import { validateDesktopInput, validateDesktopUrl, type DesktopCommand } from './desktop-control';
import { COMPUTER_TOOL } from '../lib/agent-profile';
import type { ToolReviews } from './tool-reviews';
import { desktopUploadResult, validateDesktopUploadName } from './computer-files';

export class ComputerActions {
  constructor(private store:Store,private reviews:ToolReviews,private key:string){
    store.db.exec("CREATE TABLE IF NOT EXISTS computer_actions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,argument_hash TEXT NOT NULL,state TEXT NOT NULL)");
    if (!(store.db.prepare('PRAGMA table_info(computer_actions)').all() as Array<{name:string}>).some(column=>column.name==='result_json')) store.db.exec('ALTER TABLE computer_actions ADD COLUMN result_json TEXT');
    store.db.exec("UPDATE computer_actions SET state='uncertain' WHERE state='dispatching'");
  }
  async call(runId:string,input:Record<string,unknown>,permitted:()=>boolean,execute:(command:DesktopCommand)=>Promise<Record<string,unknown>>){
    if(!permitted())throw new ProductError('This task no longer has permission to control the computer.',403);
    if(input.action==='capture')return execute({action:'frame',expiresAt:Date.now()+20000});
    const command:DesktopCommand=input.action==='navigate'?{action:'navigate',url:validateDesktopUrl(input.url)}:input.action==='input'?{action:'input',input:validateDesktopInput(input.input)}:input.action==='stage-upload'?{action:'stage-upload',fileName:validateDesktopUploadName(input.fileName)}:(()=>{throw new ProductError('Choose capture, navigate, input, or stage-upload.');})();
    const id=String(input.requestId||'');if(!/^[a-f0-9-]{36}$/i.test(id))throw new ProductError('A computer action request identity is required.');
    const hash=createHmac('sha256',this.key).update(JSON.stringify(command)).digest('hex');
    const prior=this.store.db.prepare('SELECT * FROM computer_actions WHERE id=?').get(id) as {run_id:string;argument_hash:string;state:string;result_json:string|null}|undefined;
    if(prior){if(prior.run_id!==runId||prior.argument_hash!==hash)throw new ProductError('This action identity belongs to another request.',409);if(prior.state==='completed')return {...(prior.result_json?JSON.parse(prior.result_json):{ok:true}),receipt:true};throw new ProductError('This computer action is already in progress or has an uncertain outcome. Inspect its destination before continuing.',409);}
    const summary=command.action==='navigate'?`Navigate the managed browser to ${new URL(command.url!).origin}.`:command.action==='stage-upload'?`Copy the current contents of ${command.fileName} from this agent’s private exchange folder into private browser upload staging. This does not submit the file to a website.`:`Send ${command.input!.type} input to the managed browser. Typed values are omitted.`;
    const review=this.reviews.review(runId,{requestId:id,tool:COMPUTER_TOOL,argumentHash:hash,summary});
    if(review.state!=='approved')return {state:review.state,requestId:id};
    if(!permitted())throw new ProductError('Computer control changed before the action was dispatched.',409);
    this.store.db.prepare("INSERT INTO computer_actions(id,run_id,argument_hash,state) VALUES(?,?,?,'dispatching')").run(id,runId,hash);
    try{
      const result=await execute({...command,expiresAt:Date.now()+20000});
      let response:Record<string,unknown>={ok:true};
      if(command.action==='stage-upload'){
        response={ok:true,...desktopUploadResult(result,command.fileName)};
      }
      this.reviews.receipt(runId,{requestId:id,resultHash:createHmac('sha256',this.key).update(JSON.stringify(result)).digest('hex')});
      this.store.db.prepare("UPDATE computer_actions SET state='completed',result_json=? WHERE id=?").run(JSON.stringify(response),id);return response;
    }catch(error){
      this.store.db.prepare("UPDATE computer_actions SET state='uncertain' WHERE id=?").run(id);
      this.reviews.receipt(runId,{requestId:id,resultHash:createHmac('sha256',this.key).update('uncertain').digest('hex'),uncertain:true});throw error;
    }
  }
}
