'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Wallet } = require('xrpl');
const memo = require('../src/memo');
const { treeSha256 } = require('../src/tree');
const { loadConfig } = require('../src/config');
const { makeRepo, tmp } = require('./helpers');

const PY = path.join(__dirname, '..', 'verify', 'verify_anchor.py');
const pyTree = (dir, commit) => {
  const r = spawnSync('python3', [PY, '--repo', dir, '--tree', commit, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// ---------------- memo ----------------
const M = { repo: 'https://example.org/demo/repo', ref: 'main', commit: 'a'.repeat(40), tree_sha256: 'b'.repeat(64), files: 12, src: 'github' };

test('memo: canonical bytes are sorted/compact and round-trip', () => {
  const m = memo.makeMemo(M);
  const f = memo.memoField(m);
  assert.equal(memo.fromHex(f.Memo.MemoType), 'xrpl-git-anchor/v1');
  assert.equal(memo.fromHex(f.Memo.MemoData),
    '{"commit":"' + 'a'.repeat(40) + '","files":12,"ref":"main","repo":"https://example.org/demo/repo","src":"github","tree_sha256":"' + 'b'.repeat(64) + '","v":1}');
  assert.deepEqual(memo.parseAnchorMemos([f]), m);
  assert.ok(Buffer.from(f.Memo.MemoData, 'hex').length < 400, 'memo stays well under the 1 KB tx memo limit');
});

test('memo: rejects non-canonical bytes, extra keys, duplicates, bad fields', () => {
  const f = memo.memoField(memo.makeMemo(M));
  const spaced = { Memo: { ...f.Memo, MemoData: memo.toHex(JSON.stringify(memo.makeMemo(M), null, 1)) } };
  assert.equal(memo.parseAnchorMemos([spaced]), null);
  assert.equal(memo.parseAnchorMemos([f, f]), null, 'two anchor memos in one tx is ambiguous');
  assert.equal(memo.parseAnchorMemos([]), null);
  assert.throws(() => memo.makeMemo({ ...M, commit: 'XYZ' }), /commit/);
  assert.throws(() => memo.makeMemo({ ...M, tree_sha256: 'b'.repeat(63) }), /tree_sha256/);
  assert.throws(() => memo.makeMemo({ ...M, src: 'Not Valid!' }), /src/);
  assert.throws(() => memo.makeMemo({ ...M, src: 'x'.repeat(17) }), /src/);
  assert.throws(() => memo.validateMemo({ ...memo.makeMemo(M), extra: 1 }), /unknown keys/);
  assert.equal(memo.closeTimeIso(0), '2000-01-01T00:00:00.000Z');
});

test('memo: the memo type is per deployment; a memo of another type is invisible', () => {
  const m = memo.makeMemo(M);
  const g = memo.memoField(m, 'gradedlp/anchor/v1');
  assert.equal(memo.fromHex(g.Memo.MemoType), 'gradedlp/anchor/v1');
  assert.deepEqual(memo.parseAnchorMemos([g], 'gradedlp/anchor/v1'), m);
  assert.equal(memo.parseAnchorMemos([g]), null, 'default type does not match');
  assert.equal(memo.parseAnchorMemos([g, memo.memoField(m)], 'gradedlp/anchor/v1') !== null, true, 'one of each type is fine');
  assert.throws(() => memo.memoField(m, 'has space'), /memo type/);
  assert.throws(() => memo.memoField(m, 'x'.repeat(65)), /memo type/);
});

// ---------------- TREE_V1: node and python must agree ----------------
test('tree_sha256: node == independent python on awkward paths; any byte/mode/path change moves it', () => {
  const r = makeRepo();
  r.write('README.md', '# publiciq\n');
  r.write('prereg/disclosures/2026-09-25 with space.json', '{"a":1}\n');
  r.write('prereg/ünïcödé/файл.txt', 'utf8 path\n');
  r.write('prereg/empty.txt', '');
  r.write('tools/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  r.write('z/deep/er/still/deeper/x.bin', Buffer.from([0, 1, 2, 255, 10, 0]));
  r.write('a-b', '1'); r.write('a/b', '2'); r.write('a.b', '3');   // ordering traps
  fs.symlinkSync('README.md', path.join(r.dir, 'link-to-readme'));
  const c1 = r.commit('one');
  const git = path.join(r.dir, '.git');
  const n1 = treeSha256(git, c1);
  assert.deepEqual(pyTree(r.dir, c1), { commit: c1, tree_sha256: n1.tree_sha256, files: n1.files });
  assert.equal(n1.files, 10);

  r.write('prereg/empty.txt', ' '); const c2 = r.commit('byte');
  fs.chmodSync(path.join(r.dir, 'tools/run.sh'), 0o644); const c3 = r.commit('mode');
  fs.renameSync(path.join(r.dir, 'a.b'), path.join(r.dir, 'a.c')); const c4 = r.commit('rename');
  const c5 = r.commit('empty commit, same tree');
  const hs = [c1, c2, c3, c4].map((c) => treeSha256(git, c).tree_sha256);
  assert.equal(new Set(hs).size, 4);
  for (const c of [c2, c3, c4, c5]) assert.equal(treeSha256(git, c).tree_sha256, pyTree(r.dir, c).tree_sha256);
  assert.equal(treeSha256(git, c5).tree_sha256, hs[3], 'tree hash depends on content, not on commit metadata');
});

test('tree_sha256: blob cache gives identical results', () => {
  const r = makeRepo(); r.write('x', 'x'); r.write('y', 'y'); const c = r.commit('c');
  const cache = new Map();
  const a = treeSha256(path.join(r.dir, '.git'), c, cache);
  assert.equal(cache.size, 2);
  assert.deepEqual(treeSha256(path.join(r.dir, '.git'), c, cache), a);
});

// ---------------- config ----------------
test('config: refuses any seed in the environment; requires network, repo and state dir; neutral defaults', () => {
  const base = { ANCHOR_NETWORK: 'mainnet', ANCHOR_REPO_URL: 'https://example.org/demo/repo.git', ANCHOR_STATE_DIR: '/var/lib/xrpl-git-anchor' };
  assert.throws(() => loadConfig({ ...base, ANCHOR_SEED: 'x' }), /secret/);
  assert.throws(() => loadConfig({ ...base, WALLET_SECRET: 'x' }), /secret/);
  assert.throws(() => loadConfig({ ...base, WHATEVER: Wallet.generate().seed }), /secret/, 'seed-shaped value under any name');
  assert.throws(() => loadConfig({}), /ANCHOR_NETWORK/);
  assert.throws(() => loadConfig({ ANCHOR_NETWORK: 'mainnet', ANCHOR_STATE_DIR: '/x' }), /ANCHOR_REPO_URL is required/);
  assert.throws(() => loadConfig({ ANCHOR_NETWORK: 'mainnet', ANCHOR_REPO_URL: 'https://x/y' }), /ANCHOR_STATE_DIR is required/);
  assert.throws(() => loadConfig({ ...base, ANCHOR_MEMO_TYPE: 'bad type' }), /ANCHOR_MEMO_TYPE/);
  assert.throws(() => loadConfig({ ...base, ANCHOR_SOURCE_NAME: 'Bad Name' }), /ANCHOR_SOURCE_NAME/);
  assert.throws(() => loadConfig({ ...base, ANCHOR_SOURCE_NAME: 'a', ANCHOR_FALLBACK_NAME: 'a' }), /must differ/);
  assert.throws(() => loadConfig({ ...base, ANCHOR_ACCOUNT: 'nope' }), /classic address/);
  assert.throws(() => loadConfig({ ...base, ANCHOR_REPO_URL: 'git://x' }), /https/);
  const { ANCHOR_STATE_DIR, ...noState } = base;
  const c = loadConfig({ ...noState, CREDENTIALS_DIRECTORY: '/run/credentials/xrpl-git-anchor.service', STATE_DIRECTORY: '/var/lib/xrpl-git-anchor' });
  assert.equal(c.seedPath, '/run/credentials/xrpl-git-anchor.service/seed');
  assert.equal(c.stateDir, '/var/lib/xrpl-git-anchor');
  assert.equal(c.mirrorDir, '/var/lib/xrpl-git-anchor/mirror.git');
  assert.equal(c.repoId, 'https://example.org/demo/repo');
  assert.equal(c.memoType, 'xrpl-git-anchor/v1');
  assert.equal(c.sourceName, 'primary');
  assert.equal(c.fallbackUrl, '');
  assert.equal(c.publicDir, '');
  assert.equal(c.domain, '', 'no Domain is set unless asked');
  assert.equal(c.heartbeatHours, 24);
  const g = loadConfig({ ...base, ANCHOR_MEMO_TYPE: 'gradedlp/anchor/v1', ANCHOR_SOURCE_NAME: 'github', ANCHOR_FALLBACK_NAME: 'mirror', ANCHOR_REPO_ID: 'https://github.com/x/y' });
  assert.equal(g.memoType, 'gradedlp/anchor/v1'); assert.equal(g.fallbackName, 'mirror'); assert.equal(g.repoId, 'https://github.com/x/y');
  assert.ok(c.endpoints[0].startsWith('https://'));
});

// ---------------- keygen ----------------
test('keygen: prints address + public key only, 0400 O_EXCL file, refuses overwrite and loose dirs', () => {
  const d = tmp('kg-'); fs.chmodSync(d, 0o700);
  const seedPath = path.join(d, 'seed');
  const kg = (p) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'keygen.js'), p], { encoding: 'utf8' });
  const r = kg(seedPath);
  assert.equal(r.status, 0, r.stderr);
  const seed = fs.readFileSync(seedPath, 'utf8').trim();
  assert.ok(!r.stdout.includes(seed) && !/\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/.test(r.stdout), 'seed never printed');
  const addr = /ADDRESS=(r\w+)/.exec(r.stdout)[1];
  assert.equal(Wallet.fromSeed(seed).classicAddress, addr);
  assert.equal(fs.statSync(seedPath).mode & 0o777, 0o400);
  assert.equal(kg(seedPath).status, 3, 'refuses to overwrite a (possibly funded) key');
  const loose = tmp('kg2-'); fs.chmodSync(loose, 0o755);
  assert.equal(kg(path.join(loose, 'seed')).status, 3);
});

// ---------------- seed file permissions ----------------
test('seed perms: owner-only anywhere; 0440 only as the systemd credential in the own-group creds dir; never other', () => {
  const { loadWallet } = require('../src/seed');
  const w = Wallet.generate();
  const d = tmp('cred-'); const p = path.join(d, 'seed');
  fs.writeFileSync(p, w.seed + '\n');
  fs.chmodSync(p, 0o400);
  assert.equal(loadWallet(p, {}).classicAddress, w.classicAddress);
  fs.chmodSync(p, 0o440);                                   // what systemd LoadCredential actually produces
  assert.equal(loadWallet(p, { CREDENTIALS_DIRECTORY: d }).classicAddress, w.classicAddress);
  assert.throws(() => loadWallet(p, {}), /group-readable/, '0440 outside a credentials dir is refused');
  assert.throws(() => loadWallet(p, { CREDENTIALS_DIRECTORY: tmp('other-') }), /group-readable/);
  fs.chmodSync(p, 0o444);
  assert.throws(() => loadWallet(p, { CREDENTIALS_DIRECTORY: d }), /other users/);
});

// ---------------- SPEC.md test vectors: both implementations, both git object formats ----------------
const { sh } = require('./helpers');
function vectorRepo(objectFormat, withGitlink) {
  const dir = tmp('vec-');
  sh(dir, 'git', ['init', '-q', '-b', 'main', `--object-format=${objectFormat}`]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'a b'));
  fs.writeFileSync(path.join(dir, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(dir, 'bin', 'run.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'a b', 'ü.txt'), '');
  fs.symlinkSync('README.md', path.join(dir, 'link'));
  sh(dir, 'git', ['add', '-A']);
  if (withGitlink) sh(dir, 'git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`]);
  sh(dir, 'git', ['-c', 'user.name=v', '-c', 'user.email=v@v', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'vector']);
  return { dir, commit: sh(dir, 'git', ['rev-parse', 'HEAD']) };
}

test('SPEC vectors 1-2: TREE_V1 is the published constant in node and python, for SHA-1 and SHA-256 repos', () => {
  const V1 = '9c10998a59d538b51cc6fe82246ea54b6b45217537bf6100acf08b8bf77a8b18';
  const V2 = '9bbd03f50eb286c449a588e04f29827ddac343405b3b21da4e6032077b66db3d';
  for (const [fmt, gl, want, n] of [['sha1', false, V1, 4], ['sha256', false, V1, 4], ['sha1', true, V2, 5]]) {
    const r = vectorRepo(fmt, gl);
    assert.deepEqual(treeSha256(path.join(r.dir, '.git'), r.commit), { tree_sha256: want, files: n }, `node ${fmt} gitlink=${gl}`);
    assert.deepEqual(pyTree(r.dir, r.commit), { commit: r.commit, tree_sha256: want, files: n }, `python ${fmt} gitlink=${gl}`);
    if (fmt === 'sha256') assert.match(r.commit, /^[0-9a-f]{64}$/, 'a SHA-256 commit id is accepted');
  }
});

test('SPEC vector 3: canonical memo bytes and hex fields', () => {
  const f = memo.memoField(memo.makeMemo({ repo: 'https://example.org/demo/repo', ref: 'main', commit: 'a'.repeat(40), tree_sha256: 'b'.repeat(64), files: 12, src: 'github' }));
  assert.equal(f.Memo.MemoType, '7872706C2D6769742D616E63686F722F7631');
  assert.equal(f.Memo.MemoFormat, '6170706C69636174696F6E2F6A736F6E');
  assert.equal(memo.fromHex(f.Memo.MemoData), '{"commit":"' + 'a'.repeat(40) + '","files":12,"ref":"main","repo":"https://example.org/demo/repo","src":"github","tree_sha256":"' + 'b'.repeat(64) + '","v":1}');
  const sha256Commit = memo.makeMemo({ repo: 'https://example.org/demo/repo', ref: 'main', commit: 'c'.repeat(64), tree_sha256: 'b'.repeat(64), files: 1, src: 'primary' });
  assert.equal(sha256Commit.commit.length, 64);
});
