'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('xrpl');
const { setRegularKey, sweep, signSubmitWait } = require('../src/submit');
const { createLedger } = require('./helpers');

function setup() {
  const box = Wallet.generate();                   // the anchor key on the server
  const xaman = Wallet.generate();                 // stands in for the operator's own wallet (e.g. Xaman)
  const L = createLedger({ account: box.classicAddress, balanceDrops: 10_000_000 });
  L.accounts.set(xaman.classicAddress, { Account: xaman.classicAddress, Balance: '50000000', Sequence: 1, OwnerCount: 0, Flags: 0 });
  const cfg = { account: box.classicAddress, maxFeeDrops: 5000, lastLedgerOffset: 20, waitMs: 60000, pollMs: 1 };
  return { box, xaman, L, cfg, rpc: L.rpc };
}

test('regular key: after SetRegularKey the Xaman key alone can move the funds (server lost scenario)', async () => {
  const c = setup();
  // Before: a Xaman-signed tx for the anchor account is refused by the ledger.
  await assert.rejects(signSubmitWait(c.rpc, c.xaman,
    { TransactionType: 'Payment', Account: c.cfg.account, Destination: c.xaman.classicAddress, Amount: '1000000' }, c.cfg), /expired|rejected/);
  const r = await setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: c.xaman.classicAddress });
  assert.match(r.hash, /^[0-9A-F]{64}$/);
  assert.equal(c.L.accounts.get(c.cfg.account).RegularKey, c.xaman.classicAddress);
  // After: the same Xaman-signed payment validates. The box key is not involved.
  const p = await signSubmitWait(c.rpc, c.xaman,
    { TransactionType: 'Payment', Account: c.cfg.account, Destination: c.xaman.classicAddress, Amount: '1000000' }, c.cfg);
  assert.equal(p.tx.meta.TransactionResult, 'tesSUCCESS');
  // And the box's master key still signs (anchoring unaffected).
  await setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: null });
  assert.equal(c.L.accounts.get(c.cfg.account).RegularKey, undefined);
});

test('regular key: refuses typos, self, unactivated targets', async () => {
  const c = setup();
  await assert.rejects(setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: 'rNOTANADDRESS' }), /classic/);
  await assert.rejects(setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: c.cfg.account }), /itself/);
  const ghost = Wallet.generate().classicAddress;
  await assert.rejects(setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: ghost }), /not an activated account/);
  await setRegularKey({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, target: ghost, allowUnfunded: true });
  assert.equal(c.L.accounts.get(c.cfg.account).RegularKey, ghost);
});

test('sweep: sends balance - reserve - fee, leaves exactly the reserve; refuses unsafe destinations', async () => {
  const c = setup();
  const before = Number(c.L.accounts.get(c.xaman.classicAddress).Balance);
  const r = await sweep({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, dest: c.xaman.classicAddress });
  assert.equal(c.L.accounts.get(c.cfg.account).Balance, '1000000', 'exactly the 1 XRP reserve remains');
  assert.equal(Number(c.L.accounts.get(c.xaman.classicAddress).Balance) - before, r.amount_xrp * 1e6);
  assert.equal(r.delivered_xrp, r.amount_xrp);
  await assert.rejects(sweep({ rpc: c.rpc, wallet: c.box, cfg: c.cfg, dest: c.xaman.classicAddress }), /nothing to sweep/);

  const d = setup();
  await assert.rejects(sweep({ rpc: d.rpc, wallet: d.box, cfg: d.cfg, dest: d.cfg.account }), /itself/);
  await assert.rejects(sweep({ rpc: d.rpc, wallet: d.box, cfg: d.cfg, dest: Wallet.generate().classicAddress }), /not an activated/);
  d.L.accounts.get(d.xaman.classicAddress).Flags = 0x00020000;          // exchange-style RequireDest
  await assert.rejects(sweep({ rpc: d.rpc, wallet: d.box, cfg: d.cfg, dest: d.xaman.classicAddress }), /destination tag/);
  const r2 = await sweep({ rpc: d.rpc, wallet: d.box, cfg: d.cfg, dest: d.xaman.classicAddress, tag: 12345 });
  assert.equal(r2.tx.DestinationTag, 12345);
});
