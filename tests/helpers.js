'use strict';
// Test doubles: a scratch git repository, and a fake rippled that validates signatures and keeps a
// ledger so the anchor loop, crash recovery and the Python verifier can all be exercised offline.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { decode, verifySignature, hashes, deriveAddress } = require('xrpl');

const tmp = (p = 'anc-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function sh(cwd, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, ...opts.env }, input: opts.input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const dir = tmp('repo-');
  const g = (...a) => sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a]);
  g('init', '-q', '-b', 'main');
  const write = (rel, content, mode) => {
    const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content); if (mode) fs.chmodSync(p, mode);
  };
  const commit = (msg) => { g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', msg); return g('rev-parse', 'HEAD'); };
  return { dir, g, write, commit };
}

// ---- fake rippled ----
function createLedger({ account, balanceDrops = 10_000_000, startSeq = 1000 } = {}) {
  const L = {
    seq: startSeq, closeRipple: 812000000, accounts: new Map(), txs: new Map(), pendingPool: [],
    openFee: 10, dropNext: false, rejectNext: null, calls: [], failNextSubmitNetwork: false,
  };
  if (account) L.accounts.set(account, { Account: account, Balance: String(balanceDrops), Sequence: 5, OwnerCount: 0, Flags: 0 });
  L.close = () => {                         // validate whatever is pending, advance one ledger
    L.seq += 1; L.closeRipple += 4;
    for (const p of L.pendingPool.splice(0)) {
      const acct = L.accounts.get(p.tx.Account);
      if (p.tx.LastLedgerSequence < L.seq) continue;               // expired
      if (!acct || acct.Sequence !== p.tx.Sequence) continue;
      // Authorization: the signing key must be the account's master key or its RegularKey.
      const signer = deriveAddress(p.tx.SigningPubKey);
      if (signer !== p.tx.Account && signer !== acct.RegularKey) { p.result = 'tefBAD_AUTH'; continue; }
      acct.Sequence += 1; acct.Balance = String(Number(acct.Balance) - Number(p.tx.Fee));
      const meta = { TransactionResult: 'tesSUCCESS' };
      if (p.tx.Domain !== undefined) acct.Domain = p.tx.Domain;
      if (p.tx.TransactionType === 'SetRegularKey') { if (p.tx.RegularKey) acct.RegularKey = p.tx.RegularKey; else delete acct.RegularKey; }
      if (p.tx.TransactionType === 'Payment') {
        const amt = Number(p.tx.Amount);
        const reserve = 1_000_000 + 200_000 * acct.OwnerCount;
        let dest = L.accounts.get(p.tx.Destination);
        if (Number(acct.Balance) - amt < reserve) meta.TransactionResult = 'tecUNFUNDED_PAYMENT';
        else if (!dest && amt < 1_000_000) meta.TransactionResult = 'tecNO_DST_INSUF_XRP';
        else {
          if (!dest) { dest = { Account: p.tx.Destination, Balance: '0', Sequence: 1, OwnerCount: 0, Flags: 0 }; L.accounts.set(dest.Account, dest); }
          acct.Balance = String(Number(acct.Balance) - amt); dest.Balance = String(Number(dest.Balance) + amt);
          meta.delivered_amount = p.tx.Amount;
        }
      }
      L.txs.set(p.hash, { ...p.tx, hash: p.hash, ledger_index: L.seq, date: L.closeRipple, validated: true, meta });
    }
  };
  L.handle = (method, params) => {
    L.calls.push(method);
    switch (method) {
      case 'server_info': return { info: { validated_ledger: { seq: L.seq, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } };
      case 'account_info': {
        const a = L.accounts.get(params.account);
        if (!a) return { status: 'error', error: 'actNotFound', error_message: 'Account not found.' };
        return { account_data: { ...a }, validated: params.ledger_index === 'validated' };
      }
      case 'fee': return { drops: { base_fee: '10', open_ledger_fee: String(L.openFee) } };
      case 'submit': {
        if (L.failNextSubmitNetwork) { L.failNextSubmitNetwork = false; L.pendingPool.push(submitParse(params.tx_blob)); throw new Error('socket hang up'); }
        if (L.rejectNext) { const er = L.rejectNext; L.rejectNext = null; return { engine_result: er, engine_result_message: 'rejected' }; }
        const p = submitParse(params.tx_blob);
        if (!L.dropNext) L.pendingPool.push(p); else L.dropNext = false;
        return { engine_result: 'tesSUCCESS', tx_json: { hash: p.hash } };
      }
      case 'tx': {
        L.close();                                                 // each poll = one ledger passes
        const t = L.txs.get(params.transaction);
        if (t) return { ...t };
        return { status: 'error', error: 'txnNotFound', searched_all: true };
      }
      case 'account_tx': {
        const txs = [...L.txs.values()].filter((t) => t.Account === params.account)
          .map((t) => ({ tx: { ...t, meta: undefined, validated: undefined }, meta: t.meta, validated: true }));
        return { account: params.account, transactions: txs };
      }
      default: return { status: 'error', error: 'unknownCmd' };
    }
  };
  L.rpc = {
    call: async (method, params = {}) => {
      const r = L.handle(method, params);
      if (r.status === 'error') { const { RpcError } = require('../src/rpc'); throw new RpcError(method, r); }
      return r;
    },
  };
  return L;
}

function submitParse(blob) {
  if (!verifySignature(blob)) throw new Error('bad signature');
  return { tx: decode(blob), hash: hashes.hashSignedTx(blob) };
}

// Serves the fake ledger as JSON-RPC over HTTP for the Python verifier.
function serveLedger(L) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const { method, params } = JSON.parse(b);
        let result;
        try { result = L.handle(method, params[0] || {}); } catch (e) { result = { status: 'error', error: e.message }; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }));
  });
}

module.exports = { tmp, sh, makeRepo, createLedger, serveLedger };
