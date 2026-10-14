'use strict';
// One run of the anchor service (systemd oneshot, run by a timer, e.g. every 30 minutes):
//   1. finish any tx a previous run left "pending" (crash-safe: the signed blob is saved BEFORE submit)
//   2. fetch the branch (primary source first, optional fallback second) into the private mirror
//   3. compute tree_sha256 for that commit
//   4. anchor if the commit changed, or if the last anchor is older than the heartbeat (24h)
//   5. record the proof (state dir + public /anchors/ files), warn once a day if the balance runs low
// Anything unexpected throws -> non-zero exit -> OnFailure ntfy alert.

const fs = require('node:fs');
const path = require('node:path');
const { memoField, makeMemo, parseAnchorMemos, closeTimeIso, toHex } = require('./memo');
const { treeSha256, fileHashes } = require('./tree');
const repo = require('./repo');
const { RpcError } = require('./rpc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- small durable-file helpers ----------
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return dflt; throw e; }
}
function writeAtomic(p, text, mode = 0o644) {
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}
const writeJson = (p, obj, mode) => writeAtomic(p, JSON.stringify(obj, null, 2) + '\n', mode);

function createStore(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, 'state.json');
  const cachePath = path.join(stateDir, 'blobcache.json');
  const proofsPath = path.join(stateDir, 'proofs.jsonl');
  return {
    load: () => readJson(statePath, {}),
    save: (s) => writeJson(statePath, s, 0o600),
    loadCache: () => new Map(Object.entries(readJson(cachePath, {}))),
    saveCache: (m) => writeAtomic(cachePath, JSON.stringify(Object.fromEntries(m)), 0o600),
    appendProof: (p) => {
      const fd = fs.openSync(proofsPath, 'a', 0o644);
      try { fs.writeSync(fd, JSON.stringify(p) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
    proofs: () => {
      if (!fs.existsSync(proofsPath)) return [];
      return fs.readFileSync(proofsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// ---------- ledger helpers ----------
async function validatedSeq(rpc) {
  const r = await rpc.call('server_info');
  const vl = r.info && r.info.validated_ledger;
  if (!vl || !Number.isInteger(vl.seq)) throw new Error('server_info: no validated ledger');
  return { seq: vl.seq, reserveBase: Number(vl.reserve_base_xrp), reserveInc: Number(vl.reserve_inc_xrp) };
}

function txBody(r) { return r.tx_json ? { ...r.tx_json, hash: r.hash, ledger_index: r.ledger_index, meta: r.meta, validated: r.validated, date: r.tx_json.date ?? r.date } : r; }

// Waits until `hash` is validated, or provably can never be (validated ledger past LastLedgerSequence
// and a server that searched the whole range). Returns {status:'validated', tx} | {status:'expired'}
// | {status:'unknown'} (still undecided when the wait budget ran out; stays pending for next run).
async function waitFinal(rpc, { hash, minLedger, lls }, { waitMs, pollMs = 3000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = await rpc.call('tx', { transaction: hash, min_ledger: minLedger, max_ledger: lls });
      if (r.validated) return { status: 'validated', tx: txBody(r) };
    } catch (e) {
      if (!(e instanceof RpcError) || e.code !== 'txnNotFound') throw e;
      if (e.result.searched_all) {
        const { seq } = await validatedSeq(rpc);
        if (seq > lls) return { status: 'expired' };
      }
    }
    if (Date.now() > deadline) return { status: 'unknown' };
    await sleep(pollMs);
  }
}

function proofFrom(cfg, tx, pending) {
  const memo = parseAnchorMemos(tx.Memos, cfg.memoType);
  if (!memo) throw new Error(`validated tx ${tx.hash} carries no well-formed anchor memo`);
  if (memo.commit !== pending.memo.commit || memo.tree_sha256 !== pending.memo.tree_sha256) {
    throw new Error(`validated tx ${tx.hash} memo does not match what was signed`);
  }
  return {
    v: 1, network: cfg.network, account: tx.Account, tx_hash: tx.hash,
    ledger_index: tx.ledger_index, close_time_iso: closeTimeIso(tx.date), close_time_ripple: tx.date,
    sequence: tx.Sequence, fee_drops: tx.Fee, domain_set: tx.Domain !== undefined, memo,
  };
}

function publish(cfg, store) {
  if (!cfg.publicDir) return;
  fs.mkdirSync(cfg.publicDir, { recursive: true });
  const proofs = store.proofs();
  const index = {
    v: 1,
    what: `XRPL anchors of ${cfg.label}. Each proof: an XRPL tx whose memo commits to a commit of ${cfg.repoId} + its tree_sha256. Verify independently with verify_anchor.py (xrpl-git-anchor).`,
    network: cfg.network, account: cfg.account, repo: cfg.repoId, memo_type: cfg.memoType,
    count: proofs.length, updated: new Date().toISOString(), proofs,
  };
  writeJson(path.join(cfg.publicDir, 'index.json'), index);
  if (proofs.length) writeJson(path.join(cfg.publicDir, 'latest.json'), proofs[proofs.length - 1]);
}

// ---------- per-file index: the FIRST anchor that contains each exact file ----------
// files.json maps path -> [{sha256, tx_hash, ledger_index, close_time_iso}], one entry per distinct
// byte-version of that path, each carrying the earliest anchor whose commit held exactly those bytes.
// It is derived only from proofs.jsonl + the mirror, so it is rebuilt from scratch if lost and caught
// up incrementally otherwise. verify_anchor.py --file answers the same question independently.
function updateFileIndex(cfg, store, cache, log = () => {}) {
  const p = path.join(cfg.stateDir, 'files.json');
  const proofs = store.proofs();
  let idx = readJson(p, null);
  if (!idx || idx.v !== 1 || idx.account !== cfg.account || !Number.isInteger(idx.proofs_indexed) || idx.proofs_indexed > proofs.length) {
    idx = { v: 1, account: cfg.account, network: cfg.network, proofs_indexed: 0, files: {} };
  }
  if (idx.proofs_indexed === proofs.length) return idx;
  for (const pr of proofs.slice(idx.proofs_indexed)) {
    let list;
    try { list = fileHashes(cfg.mirrorDir, pr.memo.commit, cache); } catch (e) {
      log('warn', 'file_index_commit_missing', { commit: pr.memo.commit, error: e.message }); list = [];
    }
    for (const f of list) {
      const versions = idx.files[f.path] || (idx.files[f.path] = []);
      if (!versions.some((v) => v.sha256 === f.sha256)) {
        versions.push({ sha256: f.sha256, tx_hash: pr.tx_hash, ledger_index: pr.ledger_index, close_time_iso: pr.close_time_iso });
      }
    }
  }
  idx.proofs_indexed = proofs.length;
  idx.first_anchor = proofs.length ? proofs[0].close_time_iso : null;
  idx.updated = new Date().toISOString();
  writeJson(p, idx, 0o600);
  if (cfg.publicDir) {
    fs.mkdirSync(cfg.publicDir, { recursive: true });
    writeJson(path.join(cfg.publicDir, 'files.json'), {
      what: `For each file of ${cfg.label}, the earliest XRPL anchor that contains exactly these bytes (sha256 of the file). Convenience index; verify any row independently with verify_anchor.py --file <path>.`,
      ...idx,
    });
  }
  return idx;
}

// ---------- the run ----------
async function runOnce({ cfg, rpc, wallet, log = () => {}, notify = async () => {}, now = () => new Date(), fetchSources }) {
  if (!cfg.account) throw new Error('ANCHOR_ACCOUNT is not set (run keygen, then put the printed address in the env file)');
  if (wallet.classicAddress !== cfg.account) throw new Error(`seed does not belong to ANCHOR_ACCOUNT ${cfg.account}`);
  const store = createStore(cfg.stateDir);
  const state = store.load();
  if (state.network && state.network !== cfg.network) throw new Error(`state is for ${state.network}, config says ${cfg.network}; refusing to mix`);
  if (state.account && state.account !== cfg.account) throw new Error(`state is for account ${state.account}, config says ${cfg.account}; refusing to mix`);
  state.network = cfg.network; state.account = cfg.account;

  const record = (tx, pending) => {
    const proof = proofFrom(cfg, tx, pending);
    store.appendProof(proof);
    state.last = { commit: proof.memo.commit, tree_sha256: proof.memo.tree_sha256, tx_hash: proof.tx_hash, ledger_index: proof.ledger_index, close_time_iso: proof.close_time_iso };
    state.count = (state.count || 0) + 1;
    delete state.pending; store.save(state);
    try { repo.pinCommit(cfg.mirrorDir, proof.memo.commit); } catch (e) { log('warn', 'pin_failed', { error: e.message }); }
    publish(cfg, store);
    log('info', 'anchored', { tx: proof.tx_hash, ledger: proof.ledger_index, close: proof.close_time_iso, commit: proof.memo.commit, tree_sha256: proof.memo.tree_sha256 });
    return proof;
  };

  // 1. a previous run's tx
  if (state.pending) {
    const p = state.pending;
    log('info', 'resolving_pending', { hash: p.hash });
    const w = await waitFinal(rpc, { hash: p.hash, minLedger: p.min_ledger, lls: p.lls }, { waitMs: cfg.waitMs, pollMs: cfg.pollMs });
    if (w.status === 'unknown') throw new Error(`pending tx ${p.hash} still undecided; will retry next run`);
    if (w.status === 'expired') { log('warn', 'pending_expired', { hash: p.hash }); delete state.pending; store.save(state); }
    else if (w.tx.meta && w.tx.meta.TransactionResult === 'tesSUCCESS') record(w.tx, p);
    else { delete state.pending; store.save(state); throw new Error(`pending tx ${p.hash} validated with ${w.tx.meta && w.tx.meta.TransactionResult} (fee spent, no anchor)`); }
  }

  // 2-3. what to anchor
  repo.ensureMirror(cfg.mirrorDir);
  const sources = fetchSources || [
    { name: cfg.sourceName, url: cfg.repoUrl, branch: cfg.branch },
    ...(cfg.fallbackUrl ? [{ name: cfg.fallbackName, url: cfg.fallbackUrl, branch: cfg.branch }] : []),
  ];
  const { commit, src } = repo.fetchFirst(cfg.mirrorDir, sources, log);
  const cache = store.loadCache();
  const { tree_sha256, files } = treeSha256(cfg.mirrorDir, commit, cache);
  try { updateFileIndex(cfg, store, cache, log); } catch (e) { log('warn', 'file_index_failed', { error: e.message }); }
  store.saveCache(cache);

  if (state.last && state.last.commit !== commit && repo.hasCommit(cfg.mirrorDir, state.last.commit)
      && !repo.isAncestor(cfg.mirrorDir, state.last.commit, commit)) {
    log('error', 'history_rewrite', { last: state.last.commit, now: commit, src });
    await notify({ title: `${cfg.label || cfg.repoId}: history REWRITTEN`, priority: 'urgent',
      body: `${src} main (${commit.slice(0, 12)}) does not descend from the last anchored commit ${state.last.commit.slice(0, 12)}. The old commit stays pinned in the anchor mirror and on-ledger. Investigate.` });
  }

  // 4. decide
  const t = now();
  const ageH = state.last ? (t - new Date(state.last.close_time_iso)) / 3600e3 : Infinity;
  const changed = !state.last || state.last.commit !== commit || state.last.tree_sha256 !== tree_sha256;
  if (!changed && ageH < cfg.heartbeatHours) {
    log('info', 'unchanged', { commit, tree_sha256, last_anchor_age_h: Number(ageH.toFixed(2)) });
    store.save(state);
    return { action: 'unchanged', commit, tree_sha256 };
  }

  // 5. build, sign, persist, submit
  const memo = makeMemo({ repo: cfg.repoId, ref: cfg.branch, commit, tree_sha256, files, src });
  let ai;
  try { ai = await rpc.call('account_info', { account: cfg.account, ledger_index: 'current' }); } catch (e) {
    if (e instanceof RpcError && e.code === 'actNotFound') throw new Error(`anchor account ${cfg.account} is not funded yet (send ~10 XRP)`);
    throw e;
  }
  const acct = ai.account_data;
  const fee = await rpc.call('fee');
  const base = Number(fee.drops.base_fee), open = Number(fee.drops.open_ledger_fee);
  const feeDrops = Math.ceil(Math.max(base, open) * 1.2);
  if (feeDrops > cfg.maxFeeDrops) {
    log('warn', 'fee_too_high', { feeDrops, max: cfg.maxFeeDrops });
    store.save(state);
    return { action: 'fee_too_high', feeDrops };
  }
  const { seq: vseq } = await validatedSeq(rpc);
  const tx = {
    TransactionType: 'AccountSet', Account: cfg.account, Sequence: acct.Sequence,
    Fee: String(feeDrops), LastLedgerSequence: vseq + cfg.lastLedgerOffset, Memos: [memoField(memo, cfg.memoType)],
  };
  const wantDomain = cfg.domain ? toHex(cfg.domain) : '';
  if (wantDomain && (acct.Domain || '').toUpperCase() !== wantDomain) tx.Domain = wantDomain;
  const signed = wallet.sign(tx);
  state.pending = { hash: signed.hash, tx_blob: signed.tx_blob, min_ledger: vseq, lls: tx.LastLedgerSequence, memo, created_at: t.toISOString() };
  store.save(state);                                   // durable BEFORE the network sees it
  log('info', 'submitting', { hash: signed.hash, fee: feeDrops, sequence: acct.Sequence, lls: tx.LastLedgerSequence, domain: !!tx.Domain, commit, src });

  const sub = await rpc.call('submit', { tx_blob: signed.tx_blob });
  const er = sub.engine_result || '';
  if (/^(tem|tel)/.test(er) || (/^tef/.test(er) && er !== 'tefPAST_SEQ' && er !== 'tefALREADY')) {
    delete state.pending; store.save(state);           // never applied; nothing consumed
    throw new Error(`submit rejected: ${er} ${sub.engine_result_message || ''}`);
  }
  const w = await waitFinal(rpc, { hash: signed.hash, minLedger: vseq, lls: tx.LastLedgerSequence }, { waitMs: cfg.waitMs, pollMs: cfg.pollMs });
  if (w.status === 'unknown') throw new Error(`tx ${signed.hash} not final yet (submit said ${er}); stays pending for next run`);
  if (w.status === 'expired') { delete state.pending; store.save(state); throw new Error(`tx ${signed.hash} expired unvalidated (submit said ${er})`); }
  if (!w.tx.meta || w.tx.meta.TransactionResult !== 'tesSUCCESS') {
    delete state.pending; store.save(state);
    throw new Error(`tx ${signed.hash} validated with ${w.tx.meta && w.tx.meta.TransactionResult}`);
  }
  const proof = record(w.tx, state.pending);
  try { updateFileIndex(cfg, store, cache, log); store.saveCache(cache); } catch (e) { log('warn', 'file_index_failed', { error: e.message }); }

  // 6. balance watch (once per UTC day)
  try {
    const after = await rpc.call('account_info', { account: cfg.account, ledger_index: 'validated' });
    const vi = await validatedSeq(rpc);
    const bal = Number(after.account_data.Balance) / 1e6;
    const reserve = vi.reserveBase + vi.reserveInc * Number(after.account_data.OwnerCount || 0);
    const spendable = bal - reserve;
    const day = t.toISOString().slice(0, 10);
    if (spendable < cfg.minSpendableXrp && state.low_balance_warned !== day) {
      state.low_balance_warned = day; store.save(state);
      await notify({ title: 'anchor account balance low', priority: 'high',
        body: `${cfg.account} spendable ${spendable.toFixed(6)} XRP (balance ${bal}, reserve ${reserve}). Top it up; each anchor costs ~${feeDrops} drops.` });
    }
    proof.spendable_xrp = spendable;
  } catch (e) { log('warn', 'balance_check_failed', { error: e.message }); }
  return { action: 'anchored', proof };
}

module.exports = { runOnce, waitFinal, createStore, publish, proofFrom, readJson, writeAtomic, updateFileIndex };
