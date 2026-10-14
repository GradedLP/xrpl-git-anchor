'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Wallet } = require('xrpl');
const { runOnce } = require('../src/anchor');
const { treeSha256 } = require('../src/tree');
const { fromHex } = require('../src/memo');
const { makeRepo, createLedger, serveLedger, tmp } = require('./helpers');

const PY = path.join(__dirname, '..', 'verify', 'verify_anchor.py');

function setup({ fund = true, memoType = 'xrpl-git-anchor/v1' } = {}) {
  const wallet = Wallet.generate();
  const L = createLedger({ account: fund ? wallet.classicAddress : null });
  const repo = makeRepo();
  repo.write('README.md', 'demo\n'); repo.write('prereg/a.json', '{"a":1}\n');
  repo.commit('init');
  const state = tmp('st-');
  const pub = tmp('pub-');
  const cfg = {
    network: 'testnet', account: wallet.classicAddress, repoId: 'https://example.org/demo/repo', branch: 'main', memoType, label: 'demo repo',
    sourceName: 'primary', fallbackName: 'fallback',
    stateDir: state, mirrorDir: path.join(state, 'mirror.git'), publicDir: pub,
    heartbeatHours: 24, maxFeeDrops: 5000, minSpendableXrp: 2, lastLedgerOffset: 20, waitMs: 60000, pollMs: 1, domain: 'example.org',
  };
  const notes = [];
  let clock = new Date('2026-09-26T02:07:00Z');
  L.closeRipple = Math.floor(clock / 1000) - 946684800;
  const ctx = {
    wallet, L, repo, cfg, notes,
    advance: (h) => { clock = new Date(clock.getTime() + h * 3600e3); L.closeRipple = Math.floor(clock / 1000) - 946684800; },
    run: (over = {}) => runOnce({ cfg, rpc: L.rpc, wallet, notify: async (n) => notes.push(n), now: () => clock,
      fetchSources: [{ name: 'primary', url: repo.dir, branch: 'main' }], ...over }),
    state: () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8')),
  };
  return ctx;
}

test('first run anchors HEAD, sets Domain once, writes proof + public index', async () => {
  const c = setup();
  const r = await c.run();
  assert.equal(r.action, 'anchored');
  const head = c.repo.g('rev-parse', 'HEAD');
  assert.equal(r.proof.memo.commit, head);
  assert.equal(r.proof.memo.tree_sha256, treeSha256(path.join(c.repo.dir, '.git'), head).tree_sha256);
  assert.equal(r.proof.memo.src, 'primary');
  assert.equal(r.proof.domain_set, true);
  assert.equal(fromHex(c.L.accounts.get(c.cfg.account).Domain), 'example.org');
  const idx = JSON.parse(fs.readFileSync(path.join(c.cfg.publicDir, 'index.json'), 'utf8'));
  assert.equal(idx.count, 1); assert.equal(idx.proofs[0].tx_hash, r.proof.tx_hash);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.cfg.publicDir, 'latest.json'), 'utf8')), idx.proofs[0]);
  assert.equal(c.state().pending, undefined);
  assert.equal(fs.statSync(path.join(c.cfg.stateDir, 'state.json')).mode & 0o777, 0o600);
  assert.ok(Number(r.proof.fee_drops) <= 5000);
});

test('unchanged repo -> no tx; new commit -> anchor (no Domain rewrite); 24h heartbeat -> anchor', async () => {
  const c = setup();
  await c.run();
  const submits = () => c.L.calls.filter((m) => m === 'submit').length;
  c.advance(1);
  assert.equal((await c.run()).action, 'unchanged');
  assert.equal(submits(), 1);
  c.repo.write('prereg/b.json', '{"b":2}\n'); c.repo.commit('b');
  c.advance(1);
  const r2 = await c.run();
  assert.equal(r2.action, 'anchored'); assert.equal(r2.proof.domain_set, false);
  c.advance(23);
  assert.equal((await c.run()).action, 'unchanged');
  c.advance(1.5);
  const r3 = await c.run();
  assert.equal(r3.action, 'anchored', 'heartbeat re-anchors an unchanged repo once a day');
  assert.equal(r3.proof.memo.commit, r2.proof.memo.commit);
  assert.equal(c.state().count, 3);
});

test('crash after submit: the saved pending tx is found on-ledger by the next run, not double-sent', async () => {
  const c = setup();
  c.L.failNextSubmitNetwork = true;                 // tx reaches the ledger, but our process never hears back
  await assert.rejects(c.run(), /all endpoints failed|socket hang up/);
  assert.ok(c.state().pending, 'pending survived the crash');
  const r = await c.run();
  assert.equal(r.action, 'unchanged', 'resolved the pending tx instead of anchoring again');
  assert.equal(c.state().count, 1);
  assert.equal(c.L.calls.filter((m) => m === 'submit').length, 1);
});

test('dropped tx expires past LastLedgerSequence; next run clears it and re-anchors', async () => {
  const c = setup();
  c.L.dropNext = true;
  await assert.rejects(c.run(), /expired unvalidated/);
  assert.equal(c.state().pending, undefined);
  assert.equal((await c.run()).action, 'anchored');
});

test('tem/tel rejection: nothing consumed, pending cleared, run fails loudly', async () => {
  const c = setup();
  c.L.rejectNext = 'temMALFORMED';
  await assert.rejects(c.run(), /submit rejected: temMALFORMED/);
  assert.equal(c.state().pending, undefined);
});

test('refusals: wrong seed, unfunded account, fee spike, mixed network state', async () => {
  const c = setup();
  await assert.rejects(runOnce({ cfg: c.cfg, rpc: c.L.rpc, wallet: Wallet.generate() }), /does not belong/);
  const u = setup({ fund: false });
  await assert.rejects(u.run(), /not funded yet/);
  const f = setup(); f.L.openFee = 100000;
  assert.equal((await f.run()).action, 'fee_too_high');
  assert.equal(f.L.calls.filter((m) => m === 'submit').length, 0);
  await c.run();
  c.cfg.network = 'mainnet';
  await assert.rejects(c.run(), /refusing to mix/);
});

test('history rewrite (force-push) raises an urgent alert and still anchors the new head', async () => {
  const c = setup();
  const first = (await c.run()).proof.memo.commit;
  c.repo.g('commit', '-q', '--amend', '-m', 'rewritten');
  c.advance(1);
  const r = await c.run();
  assert.equal(r.action, 'anchored');
  assert.equal(c.notes.length, 1); assert.match(c.notes[0].title, /REWRITTEN/); assert.equal(c.notes[0].priority, 'urgent');
  const pin = spawnSync('git', ['--git-dir', c.cfg.mirrorDir, 'cat-file', '-e', first + '^{commit}']);
  assert.equal(pin.status, 0, 'the originally anchored commit is still pinned in the mirror');
});

test('low balance -> one high-priority warning per UTC day', async () => {
  const c = setup();
  c.L.accounts.get(c.cfg.account).Balance = '2500000';          // 2.5 XRP -> 1.5 spendable < 2
  await c.run();
  c.repo.write('n', '1'); c.repo.commit('n'); c.advance(1); await c.run();
  assert.equal(c.notes.filter((n) => /balance low/.test(n.title)).length, 1);
});

test('fallback source is used and recorded when the primary is unreachable', async () => {
  const c = setup();
  const r = await c.run({ fetchSources: [{ name: 'primary', url: '/nonexistent/repo', branch: 'main' }, { name: 'fallback', url: c.repo.dir, branch: 'main' }] });
  assert.equal(r.proof.memo.src, 'fallback');
  await assert.rejects(c.run({ fetchSources: [{ name: 'primary', url: '/nonexistent/repo', branch: 'main' }] }), /no source fetched/);
});

// ---------------- the public verifier against the same ledger ----------------
// async on purpose: the fake rippled runs in THIS process, so a blocking spawnSync would deadlock it.
const { execFile } = require('node:child_process');
const py = (args) => new Promise((resolve) => execFile('python3', [PY, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' } },
  (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

test('verify_anchor.py: VERIFIED end-to-end, earliest-proof for a file, and catches tampering', async () => {
  const c = setup();
  await c.run();                                             // anchor 1: README + a.json
  c.repo.write('prereg/b.json', '{"b":2}\n'); c.repo.commit('b');
  c.advance(1); const r2 = await c.run();                    // anchor 2: + b.json
  const srv = await serveLedger(c.L);
  try {
    const base = ['--repo', c.repo.dir, '--account', c.cfg.account, '--network', 'testnet', '--rpc', srv.url];
    let v = await py(base);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /OK: 2 verified, 0 problem/);
    assert.match(v.stdout, /account Domain: example.org/);

    v = await py([...base, '--file', 'prereg/b.json']);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, new RegExp(`PROVEN: prereg/b.json .* tx ${r2.proof.tx_hash}`));

    v = await py([...base, '--json']);
    const j = JSON.parse(v.stdout);
    assert.equal(j.anchors.length, 2); assert.ok(j.anchors.every((a) => a.status === 'VERIFIED'));

    // A clone whose history was rewritten (same commit ids impossible, so simulate a lying repo:
    // anchored commit absent) must not pass.
    const other = makeRepo(); other.write('README.md', 'forged\n'); other.commit('forged');
    v = await py(['--repo', other.dir, '--account', c.cfg.account, '--network', 'testnet', '--rpc', srv.url]);
    assert.equal(v.status, 1); assert.match(v.stdout, /MISSING/);

    // A tampered on-ledger record (tree hash altered) must FAIL.
    const t = [...c.L.txs.values()][0];
    const bad = JSON.parse(fromHex(t.Memos[0].Memo.MemoData)); bad.tree_sha256 = 'f'.repeat(64);
    const { toHex, canonical } = require('../src/memo');
    t.Memos = [{ Memo: { ...t.Memos[0].Memo, MemoData: toHex(canonical(bad)) } }];
    v = await py(base);
    assert.equal(v.status, 1); assert.match(v.stdout, /tree mismatch/);

    // A file that was never anchored is reported as such.
    c.repo.write('prereg/new.json', '{}'); c.repo.commit('new');
    v = await py([...base, '--file', 'prereg/new.json']);
    assert.match(v.stdout, /NOT YET ANCHORED/);
  } finally { srv.close(); }
});

test('files.json: each exact file keeps its FIRST anchor; new files and changed bytes get later ones; rebuilds if lost', async () => {
  const c = setup();
  const r1 = (await c.run()).proof;
  c.repo.write('prereg/b.json', '{"b":2}\n'); c.repo.write('README.md', 'publiciq v2\n'); c.repo.commit('b');
  c.advance(1); const r2 = (await c.run()).proof;
  c.advance(25); await c.run();                                  // heartbeat: must not move any "first"
  const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'files.json'), 'utf8'));
  const idx = read(c.cfg.publicDir);
  assert.equal(idx.proofs_indexed, 3);
  assert.equal(idx.first_anchor, r1.close_time_iso);
  assert.deepEqual(idx.files['prereg/a.json'].map((v) => v.tx_hash), [r1.tx_hash], 'unchanged file keeps its first anchor');
  assert.deepEqual(idx.files['prereg/b.json'].map((v) => v.tx_hash), [r2.tx_hash]);
  assert.deepEqual(idx.files['README.md'].map((v) => v.tx_hash), [r1.tx_hash, r2.tx_hash], 'changed bytes = a second version');
  const sha = require('node:crypto').createHash('sha256').update('{"a":1}\n').digest('hex');
  assert.equal(idx.files['prereg/a.json'][0].sha256, sha, 'sha256 is of the exact file bytes');
  fs.rmSync(path.join(c.cfg.stateDir, 'files.json'));            // lost -> rebuilt identically from proofs + mirror
  c.advance(1); await c.run();
  const again = read(c.cfg.stateDir);
  assert.deepEqual(again.files, idx.files);
});

test('default sources come from config: primary ANCHOR_REPO_URL, then ANCHOR_FALLBACK_URL; the name is recorded in the memo', async () => {
  const c = setup();
  c.cfg.repoUrl = '/nonexistent/repo'; c.cfg.fallbackUrl = c.repo.dir; c.cfg.fallbackName = 'mirror';
  const r = await c.run({ fetchSources: undefined });
  assert.equal(r.proof.memo.src, 'mirror');
  c.cfg.fallbackUrl = '';
  await assert.rejects(c.run({ fetchSources: undefined }), /no source fetched/);
});

test('per-deployment memo type: anchored with it, verified with --memo-type, invisible to the default; --expect-repo', async () => {
  const c = setup({ memoType: 'gradedlp/anchor/v1' });
  const r = await c.run();
  assert.equal(fromHex(c.L.txs.get(r.proof.tx_hash).Memos[0].Memo.MemoType), 'gradedlp/anchor/v1');
  const idx = JSON.parse(fs.readFileSync(path.join(c.cfg.publicDir, 'index.json'), 'utf8'));
  assert.equal(idx.memo_type, 'gradedlp/anchor/v1');
  assert.match(idx.what, /demo repo/);
  const srv = await serveLedger(c.L);
  try {
    const base = ['--repo', c.repo.dir, '--account', c.cfg.account, '--network', 'testnet', '--rpc', srv.url];
    let v = await py([...base, '--memo-type', 'gradedlp/anchor/v1']);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /OK: 1 verified, 0 problem/);
    v = await py(base);
    assert.match(v.stdout, /anchors on ledger: 0/, 'the default memo type does not see another deployment');
    v = await py([...base, '--memo-type', 'gradedlp/anchor/v1', '--expect-repo', 'https://example.org/other']);
    assert.equal(v.status, 1); assert.match(v.stdout, /expected https:\/\/example.org\/other/);
    v = await py([...base, '--memo-type', 'gradedlp/anchor/v1', '--expect-repo', 'https://example.org/demo/repo']);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  } finally { srv.close(); }
});

test('verifier: a shallow clone is warned about, and its missing history is MISSING (not FAIL, not VERIFIED)', async () => {
  const c = setup();
  await c.run();
  c.repo.write('prereg/b.json', '{"b":2}\n'); c.repo.commit('b');
  c.advance(1); await c.run();
  const shallow = tmp('shallow-');
  spawnSync('git', ['clone', '-q', '--depth', '1', 'file://' + c.repo.dir, shallow]);
  const srv = await serveLedger(c.L);
  try {
    const v = await py(['--repo', shallow, '--account', c.cfg.account, '--network', 'testnet', '--rpc', srv.url]);
    assert.equal(v.status, 1);
    assert.match(v.stdout, /WARNING: .* is a shallow clone/);
    assert.match(v.stdout, /MISSING .*\n.*VERIFIED/s, 'older anchor MISSING, newest VERIFIED');
    assert.doesNotMatch(v.stdout, /FAIL /);
  } finally { srv.close(); }
});
