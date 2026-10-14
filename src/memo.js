'use strict';
// The on-ledger record. One AccountSet (no-op) tx carrying one memo:
//   MemoType   = the deployment's memo type (default "xrpl-git-anchor/v1"; configurable so that each
//                deployment can be told apart on-ledger, e.g. "gradedlp/anchor/v1")
//   MemoFormat = "application/json"
//   MemoData   = canonical JSON (keys sorted, no whitespace, ASCII) of:
//     { v:1, repo, ref, commit, tree_sha256, files, src }
// The exact bytes are reproducible from the fields, so a verifier can re-encode and compare.

const DEFAULT_MEMO_TYPE = 'xrpl-git-anchor/v1';
const MEMO_FORMAT = 'application/json';
const RIPPLE_EPOCH = 946684800;
const MEMO_TYPE_RE = /^[\x21-\x7e]{1,64}$/;
const SRC_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;      // which source the commit was fetched from (e.g. github, mirror)

const toHex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const fromHex = (h) => Buffer.from(String(h || ''), 'hex').toString('utf8');

function canonical(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('canonical: only safe integers allowed');
    if (typeof v === 'string' && /[^\x20-\x7e]/.test(v)) throw new Error('canonical: ASCII printable strings only');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

const HEX40 = /^[0-9a-f]{40}$/;       // git sha1 object id
const HEX64 = /^[0-9a-f]{64}$/;       // git sha256 object id / tree_sha256

function makeMemo({ repo, ref, commit, tree_sha256, files, src }) {
  const m = { v: 1, repo, ref, commit, tree_sha256, files, src };
  validateMemo(m);
  return m;
}

function validateMemo(m) {
  const errs = [];
  if (m.v !== 1) errs.push('v');
  if (typeof m.repo !== 'string' || !/^https:\/\/[\x21-\x7e]{1,200}$/.test(m.repo)) errs.push('repo');
  if (typeof m.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,64}$/.test(m.ref)) errs.push('ref');
  if (!HEX40.test(m.commit || '') && !HEX64.test(m.commit || '')) errs.push('commit');
  if (!HEX64.test(m.tree_sha256 || '')) errs.push('tree_sha256');
  if (!Number.isSafeInteger(m.files) || m.files < 0) errs.push('files');
  if (typeof m.src !== 'string' || !SRC_RE.test(m.src)) errs.push('src');
  const extra = Object.keys(m).filter((k) => !['v', 'repo', 'ref', 'commit', 'tree_sha256', 'files', 'src'].includes(k));
  if (extra.length) errs.push('unknown keys: ' + extra.join(','));
  if (errs.length) throw new Error('bad anchor memo: ' + errs.join('; '));
  return m;
}

function checkType(memoType) {
  if (!MEMO_TYPE_RE.test(memoType || '')) throw new Error('bad memo type');
  return memoType;
}

function memoField(m, memoType = DEFAULT_MEMO_TYPE) {
  return { Memo: { MemoType: toHex(checkType(memoType)), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(canonical(validateMemo(m))) } };
}

// Returns the parsed memo if `memos` (a tx's Memos array) carries exactly one well-formed anchor
// memo of `memoType` whose bytes are canonical; otherwise null. Non-canonical bytes are rejected on purpose.
function parseAnchorMemos(memos, memoType = DEFAULT_MEMO_TYPE) {
  checkType(memoType);
  const found = (memos || []).map((x) => x && x.Memo).filter((m) => m && fromHex(m.MemoType) === memoType);
  if (found.length !== 1) return null;
  const raw = fromHex(found[0].MemoData);
  let obj;
  try { obj = JSON.parse(raw); validateMemo(obj); } catch { return null; }
  if (canonical(obj) !== raw) return null;
  if (fromHex(found[0].MemoFormat) !== MEMO_FORMAT) return null;
  return obj;
}

const closeTimeIso = (rippleSeconds) => new Date((rippleSeconds + RIPPLE_EPOCH) * 1000).toISOString();

module.exports = {
  DEFAULT_MEMO_TYPE, MEMO_FORMAT, RIPPLE_EPOCH, MEMO_TYPE_RE, SRC_RE,
  toHex, fromHex, canonical, makeMemo, validateMemo, memoField, parseAnchorMemos, closeTimeIso,
};
