import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import { integer, ProductError, text } from '../runtime/product-error';

type Reservation = { id: string; workspace_id: string; run_id: string; request_id: string; request_hash: string; model: string; maximum: string; input_rate: string; output_rate: string; period: string; state: string; charged: string | null;provider_receipt:string|null };
const cost = (tokens: number, rate: unknown) => (BigInt(tokens) * BigInt(String(rate)) + BigInt(999999)) / BigInt(1000000);
const micros = (value: unknown) => integer(value, 'Amount in microdollars', 0, 9_000_000_000_000);
export class UsageLedger {
  constructor(private db: Database) {}
  async reserve(input: { workspaceId: string; runId: string; requestId: string; requestHash: string; model: string; inputTokenBound: number; outputTokenBound: number }) {
    integer(input.inputTokenBound, 'Input token bound', 1, 1_000_000); integer(input.outputTokenBound, 'Output token bound', 1, 1_000_000);
    return this.db.transaction(async sql => {
      const wallet = (await sql.query('SELECT * FROM wallets WHERE workspace_id=$1 FOR UPDATE', [input.workspaceId])).rows[0]; if (!wallet) throw new ProductError('Model usage is not enabled for this workspace.', 402);
      if(wallet.frozen)throw new ProductError('Usage is paused while a billing adjustment is reconciled.',402);
      const prior = (await sql.query('SELECT * FROM usage_reservations WHERE workspace_id=$1 AND request_id=$2', [input.workspaceId, text(input.requestId, 'Model request identity', 200)])).rows[0] as Reservation | undefined;
      if (prior) { if (prior.request_hash !== input.requestHash || prior.run_id !== input.runId || prior.model !== input.model) throw new ProductError('This usage request identity belongs to another request.', 409); return prior; }
      if(Number((await sql.query("SELECT count(*) AS count FROM usage_reservations WHERE workspace_id=$1 AND state IN ('reserved','dispatching')",[input.workspaceId])).rows[0].count)>=4)throw new ProductError('This workspace already has four outstanding model requests. Wait for usage to settle or ask the service operator to reconcile a stalled request.',429);
      const rate = (await sql.query('SELECT * FROM model_rates WHERE model=$1 AND active=true', [input.model])).rows[0]; if (!rate) throw new ProductError('This model has no approved platform rate.', 409);
      if (input.outputTokenBound > rate.max_output_tokens) throw new ProductError('The requested output exceeds this model’s configured limit.');
      const maximum = cost(input.inputTokenBound, rate.input_microdollars_per_million) + cost(input.outputTokenBound, rate.output_microdollars_per_million), period = new Date().toISOString().slice(0, 7);
      await sql.query('INSERT INTO usage_periods(workspace_id,period) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.workspaceId, period]);
      const current = (await sql.query('SELECT * FROM usage_periods WHERE workspace_id=$1 AND period=$2 FOR UPDATE', [input.workspaceId, period])).rows[0];
      if (maximum > BigInt(wallet.balance) - BigInt(wallet.reserved) || maximum + BigInt(current.spent) + BigInt(current.reserved) > BigInt(wallet.hard_limit)) throw new ProductError('This request exceeds the workspace balance or hard spending limit.', 402);
      const id = randomUUID(); await sql.query('UPDATE wallets SET reserved=reserved+$1 WHERE workspace_id=$2', [maximum.toString(), input.workspaceId]); await sql.query('UPDATE usage_periods SET reserved=reserved+$1 WHERE workspace_id=$2 AND period=$3', [maximum.toString(), input.workspaceId, period]);
      const row = (await sql.query("INSERT INTO usage_reservations(id,workspace_id,run_id,request_id,request_hash,model,rate_version,input_rate,output_rate,maximum,period,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved') RETURNING *", [id, input.workspaceId, input.runId, input.requestId, input.requestHash, input.model, rate.version, rate.input_microdollars_per_million, rate.output_microdollars_per_million, maximum.toString(), period])).rows[0] as Reservation;
      await sql.query("INSERT INTO usage_journal VALUES($1,$2,$3,'reserve',$4,'Reserved before provider dispatch',now())", [randomUUID(), input.workspaceId, id, maximum.toString()]); return row;
    });
  }
  async dispatch(id: string) { if (!(await this.db.query("UPDATE usage_reservations SET state='dispatching',updated_at=now() WHERE id=$1 AND state='reserved' RETURNING id", [id])).rows.length) throw new ProductError('This model request has already been dispatched or requires reconciliation.', 409); }
  async uncertain(id: string) { await this.db.query("UPDATE usage_reservations SET state='uncertain',updated_at=now() WHERE id=$1 AND state='dispatching'", [id]); }
  async settle(id: string, inputTokens: number, outputTokens: number, providerReceipt: string) {
    integer(inputTokens, 'Provider input tokens', 0, 10_000_000); integer(outputTokens, 'Provider output tokens', 0, 10_000_000); text(providerReceipt, 'Provider receipt', 500);
    return this.db.transaction(async sql => {
      const initial = (await sql.query('SELECT workspace_id FROM usage_reservations WHERE id=$1', [id])).rows[0]; if (!initial) throw new ProductError('Usage reservation not found.', 404);
      await sql.query('SELECT workspace_id FROM wallets WHERE workspace_id=$1 FOR UPDATE', [initial.workspace_id]);
      const row = (await sql.query('SELECT * FROM usage_reservations WHERE id=$1 FOR UPDATE', [id])).rows[0] as Reservation;
      const charged = cost(inputTokens, row.input_rate) + cost(outputTokens, row.output_rate);
      if (row.state === 'settled') { if (BigInt(row.charged!) !== charged||row.provider_receipt!==providerReceipt) throw new ProductError('This usage receipt conflicts with the settled charge.', 409); return row; }
      if (!['dispatching','uncertain'].includes(row.state) || charged > BigInt(row.maximum)) throw new ProductError('Provider usage requires manual reconciliation. The reservation remains held.', 409);
      await sql.query('UPDATE wallets SET balance=balance-$1,reserved=reserved-$2 WHERE workspace_id=$3', [charged.toString(), row.maximum, row.workspace_id]);
      await sql.query('UPDATE usage_periods SET spent=spent+$1,reserved=reserved-$2 WHERE workspace_id=$3 AND period=$4', [charged.toString(), row.maximum, row.workspace_id, row.period]);
      const updated = (await sql.query("UPDATE usage_reservations SET state='settled',charged=$1,input_tokens=$2,output_tokens=$3,provider_receipt=$4,updated_at=now() WHERE id=$5 RETURNING *", [charged.toString(), inputTokens, outputTokens, providerReceipt, id])).rows[0];
      await sql.query("INSERT INTO usage_journal VALUES($1,$2,$3,'charge',$4,$5,now())", [randomUUID(), row.workspace_id, id, charged.toString(), providerReceipt]); return updated;
    });
  }
  async releaseUndispatched(id: string) {
    return this.db.transaction(async sql => {
      const initial = (await sql.query('SELECT workspace_id FROM usage_reservations WHERE id=$1', [id])).rows[0]; if (!initial) throw new ProductError('Usage reservation not found.', 404);
      await sql.query('SELECT workspace_id FROM wallets WHERE workspace_id=$1 FOR UPDATE', [initial.workspace_id]);
      const row = (await sql.query('SELECT * FROM usage_reservations WHERE id=$1 FOR UPDATE', [id])).rows[0] as Reservation;
      if (row.state === 'released') return; if (row.state !== 'reserved') throw new ProductError('Dispatched model usage cannot be released without provider reconciliation.', 409);
      await sql.query('UPDATE wallets SET reserved=reserved-$1 WHERE workspace_id=$2', [row.maximum, row.workspace_id]); await sql.query('UPDATE usage_periods SET reserved=reserved-$1 WHERE workspace_id=$2 AND period=$3', [row.maximum, row.workspace_id, row.period]);
      await sql.query("UPDATE usage_reservations SET state='released',updated_at=now() WHERE id=$1", [id]);
      await sql.query("INSERT INTO usage_journal VALUES($1,$2,$3,'release',$4,'Confirmed undispatched',now())", [randomUUID(), row.workspace_id, id, row.maximum]);
    });
  }
  async credit(source: string, eventId: string, workspaceId: string, amount: number, receiptHash: string) {
    micros(amount); if (!amount) throw new ProductError('A billing credit must be positive.');
    return this.db.transaction(async sql => {
      const wallet = (await sql.query('SELECT * FROM wallets WHERE workspace_id=$1 FOR UPDATE', [workspaceId])).rows[0]; if (!wallet) throw new ProductError('Wallet not found.', 404);
      const prior = (await sql.query('SELECT * FROM billing_events WHERE source=$1 AND event_id=$2', [source, eventId])).rows[0];
      if (prior) { if (prior.workspace_id !== workspaceId || BigInt(prior.amount) !== BigInt(amount) || prior.receipt_hash !== receiptHash) throw new ProductError('Billing event conflicts with the original receipt.', 409); return { duplicate: true }; }
      await sql.query('INSERT INTO billing_events(source,event_id,workspace_id,amount,receipt_hash) VALUES($1,$2,$3,$4,$5)', [source, eventId, workspaceId, amount, receiptHash]);
      const repaid=BigInt(wallet.debt)<BigInt(amount)?BigInt(wallet.debt):BigInt(amount);await sql.query('UPDATE wallets SET balance=balance+$1,debt=debt-$2 WHERE workspace_id=$3', [(BigInt(amount)-repaid).toString(),repaid.toString(),workspaceId]); await sql.query("INSERT INTO usage_journal VALUES($1,$2,NULL,'credit',$3,$4,now())", [randomUUID(), workspaceId, amount, `${source}:${eventId}`]); return { duplicate: false };
    });
  }
  async limits(workspaceId: string, hardLimit: number) { micros(hardLimit); await this.db.query('UPDATE wallets SET hard_limit=$1,auto_recharge=false WHERE workspace_id=$2', [hardLimit, workspaceId]); return this.summary(workspaceId); }
  async summary(workspaceId: string) { const wallet = (await this.db.query('SELECT * FROM wallets WHERE workspace_id=$1', [workspaceId])).rows[0]; const periods = (await this.db.query('SELECT * FROM usage_periods WHERE workspace_id=$1 ORDER BY period DESC LIMIT 12', [workspaceId])).rows; return { wallet, periods, unit: 'microdollars', autoRecharge: false }; }
  async refund(source:string,eventId:string,purchaseId:string,amount:number){micros(amount);return this.db.transaction(async sql=>{const purchase=(await sql.query('SELECT * FROM billing_events WHERE source=$1 AND event_id=$2',[source,purchaseId])).rows[0];if(!purchase)throw new ProductError('The original purchase has not been recorded. Retry this verified refund later.',409);const wallet=(await sql.query('SELECT * FROM wallets WHERE workspace_id=$1 FOR UPDATE',[purchase.workspace_id])).rows[0],prior=(await sql.query('SELECT * FROM billing_refunds WHERE source=$1 AND event_id=$2',[source,eventId])).rows[0];if(prior){if(prior.purchase_id!==purchaseId||BigInt(prior.amount)!==BigInt(amount))throw new ProductError('Refund identity conflicts with its original receipt.',409);return {duplicate:true};}const refunded=(await sql.query('SELECT COALESCE(sum(amount),0) AS amount FROM billing_refunds WHERE source=$1 AND purchase_id=$2',[source,purchaseId])).rows[0];if(BigInt(refunded.amount)+BigInt(amount)>BigInt(purchase.amount))throw new ProductError('Refunds exceed the recorded purchase.',409);const available=BigInt(wallet.balance)-BigInt(wallet.reserved),deduct=available<BigInt(amount)?available:BigInt(amount);await sql.query('INSERT INTO billing_refunds(source,event_id,purchase_id,workspace_id,amount) VALUES($1,$2,$3,$4,$5)',[source,eventId,purchaseId,purchase.workspace_id,amount]);await sql.query('UPDATE wallets SET balance=balance-$1,debt=debt+$2,frozen=true,auto_recharge=false WHERE workspace_id=$3',[deduct.toString(),(BigInt(amount)-deduct).toString(),purchase.workspace_id]);await sql.query("INSERT INTO usage_journal VALUES($1,$2,NULL,'refund',$3,$4,now())",[randomUUID(),purchase.workspace_id,-amount,`${source}:${eventId}`]);await sql.query("UPDATE entitlements SET state='revoked' WHERE source=$1 AND external_id=$2",[source,purchaseId]);return {duplicate:false};});}
}
