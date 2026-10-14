'use strict';
// One-off, operator-initiated transactions (regular key, sweep). Fills Sequence / Fee /
// LastLedgerSequence from the ledger, signs locally, submits, and waits until the result is final.
// The anchor loop has its own crash-safe path in anchor.js; these commands are run by hand, and they
// report the tx hash either way, so they don't persist a pending record.
const { RpcError } = require('./rpc');
const { waitFinal } = require('./anchor');

const CLASSIC = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DISALLOW_XRP = 0x00080000;

async function accountInfo(rpc, account) {
  try { return (await rpc.call('account_info', { account, ledger_index: 'validated' })).account_data; }
  catch (e) { if (e instanceof RpcError && e.code === 'actNotFound') return null; throw e; }
}

async function reserves(rpc) {
  const r = await rpc.call('server_info');
  const vl = r.info.validated_ledger;
  return { seq: vl.seq, base: Math.round(Number(vl.reserve_base_xrp) * 1e6), inc: Math.round(Number(vl.reserve_inc_xrp) * 1e6) };
}

async function feeDrops(rpc, maxFeeDrops) {
  const f = await rpc.call('fee');
  const d = Math.ceil(Math.max(Number(f.drops.base_fee), Number(f.drops.open_ledger_fee)) * 1.2);
  if (d > maxFeeDrops) throw new Error(`network fee ${d} drops is above the ${maxFeeDrops} cap; try later`);
  return d;
}

async function signSubmitWait(rpc, wallet, tx, cfg) {
  const acct = await accountInfo(rpc, tx.Account);
  if (!acct) throw new Error(`${tx.Account} is not funded`);
  const { seq } = await reserves(rpc);
  const full = { ...tx, Sequence: acct.Sequence, Fee: tx.Fee || String(await feeDrops(rpc, cfg.maxFeeDrops)), LastLedgerSequence: seq + cfg.lastLedgerOffset };
  const signed = wallet.sign(full);
  const sub = await rpc.call('submit', { tx_blob: signed.tx_blob });
  const er = sub.engine_result || '';
  if (/^(tem|tel)/.test(er) || (/^tef/.test(er) && er !== 'tefPAST_SEQ' && er !== 'tefALREADY')) {
    throw new Error(`rejected: ${er} ${sub.engine_result_message || ''} (nothing was spent)`);
  }
  const w = await waitFinal(rpc, { hash: signed.hash, minLedger: seq, lls: full.LastLedgerSequence }, { waitMs: cfg.waitMs, pollMs: cfg.pollMs });
  if (w.status === 'unknown') throw new Error(`tx ${signed.hash} not final yet; check it later on a ledger explorer`);
  if (w.status === 'expired') throw new Error(`tx ${signed.hash} expired without validating (nothing was spent)`);
  const result = w.tx.meta && w.tx.meta.TransactionResult;
  if (result !== 'tesSUCCESS') throw new Error(`tx ${signed.hash} validated with ${result}`);
  return { hash: signed.hash, ledger_index: w.tx.ledger_index, fee: full.Fee, tx: w.tx };
}

// SetRegularKey: lets another key (e.g. a wallet app you hold, such as Xaman) sign for the anchor account.
// The master key on the box keeps working, so anchoring is unaffected. `target` null = remove it.
async function setRegularKey({ rpc, wallet, cfg, target, allowUnfunded = false }) {
  if (target !== null) {
    if (!CLASSIC.test(target || '')) throw new Error('regular key must be a classic r-address');
    if (target === cfg.account) throw new Error('regular key cannot be the anchor account itself');
    if (!allowUnfunded && !(await accountInfo(rpc, target))) {
      throw new Error(`${target} is not an activated account; check for a typo (override: --allow-unfunded)`);
    }
  }
  const tx = { TransactionType: 'SetRegularKey', Account: cfg.account };
  if (target !== null) tx.RegularKey = target;
  const r = await signSubmitWait(rpc, wallet, tx, cfg);
  const after = await accountInfo(rpc, cfg.account);
  if ((after.RegularKey || null) !== target) throw new Error(`ledger shows RegularKey=${after.RegularKey || 'none'} after the tx`);
  return r;
}

// Sweep: send everything above the reserve (minus the fee) to `dest`.
async function sweep({ rpc, wallet, cfg, dest, tag, allowUnfunded = false }) {
  if (!CLASSIC.test(dest || '')) throw new Error('destination must be a classic r-address');
  if (dest === cfg.account) throw new Error('destination is the anchor account itself');
  if (tag !== undefined && (!Number.isInteger(tag) || tag < 0 || tag > 4294967295)) throw new Error('destination tag must be 0..4294967295');
  const d = await accountInfo(rpc, dest);
  if (!d && !allowUnfunded) throw new Error(`${dest} is not an activated account; check for a typo (override: --allow-unfunded)`);
  if (d && (d.Flags & LSF_REQUIRE_DEST_TAG) && tag === undefined) throw new Error(`${dest} requires a destination tag (an exchange?) - pass --tag`);
  if (d && (d.Flags & LSF_DISALLOW_XRP)) throw new Error(`${dest} has DisallowXRP set`);
  const a = await accountInfo(rpc, cfg.account);
  if (!a) throw new Error('anchor account is not funded');
  const rs = await reserves(rpc);
  const fee = await feeDrops(rpc, cfg.maxFeeDrops);
  const reserve = rs.base + rs.inc * Number(a.OwnerCount || 0);
  const amount = Number(a.Balance) - reserve - fee;
  if (amount <= 0) throw new Error(`nothing to sweep: balance ${Number(a.Balance) / 1e6} XRP, reserve ${reserve / 1e6} XRP`);
  if (!d && amount < rs.base) throw new Error(`destination is unactivated and ${amount / 1e6} XRP is below the ${rs.base / 1e6} XRP base reserve`);
  const tx = { TransactionType: 'Payment', Account: cfg.account, Destination: dest, Amount: String(amount), Fee: String(fee) };
  if (tag !== undefined) tx.DestinationTag = tag;
  const r = await signSubmitWait(rpc, wallet, tx, cfg);
  const delivered = r.tx.meta && (r.tx.meta.delivered_amount || r.tx.meta.DeliveredAmount);
  return { ...r, amount_xrp: amount / 1e6, delivered_xrp: typeof delivered === 'string' ? Number(delivered) / 1e6 : undefined, reserve_left_xrp: reserve / 1e6 };
}

module.exports = { signSubmitWait, setRegularKey, sweep, accountInfo, reserves, CLASSIC };
