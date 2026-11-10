import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Postgres} from '../control-plane/database';
import {Operations} from '../control-plane/operations';
import {text,object,integer} from '../runtime/product-error';
const [command,path]=process.argv.slice(2);if(!['reconcile','unfreeze'].includes(command)||!path)throw new Error('Usage: npm run cloud:operations -- reconcile|unfreeze OPERATOR_EVIDENCE.json');
if(!process.env.DATABASE_URL||!process.env.OPEN_HARNESS_OPERATOR_ID)throw new Error('Use a service-operator database connection and OPEN_HARNESS_OPERATOR_ID. This command is not exposed through workspace sessions.');
const source=await readFile(path,'utf8'),input=object(JSON.parse(source)),evidence=`${text(input.evidence,'Provider readback or billing adjustment evidence',2000)}; source-sha256:${createHash('sha256').update(source).digest('hex')}`,db=new Postgres(process.env.DATABASE_URL),operations=new Operations(db);
try{console.log(JSON.stringify(command==='reconcile'?await operations.reconcile({reservationId:text(input.reservationId,'Reservation',100),inputTokens:integer(input.inputTokens,'Provider input tokens',0,10000000),outputTokens:integer(input.outputTokens,'Provider output tokens',0,10000000),providerReceipt:text(input.providerReceipt,'Provider receipt',500),operator:process.env.OPEN_HARNESS_OPERATOR_ID,evidence}):await operations.unfreeze(text(input.workspaceId,'Workspace',100),process.env.OPEN_HARNESS_OPERATOR_ID,evidence),null,2));}finally{await db.pool.end();}
