# xrpl-git-anchor record format, version 1

This is everything needed to write a compatible anchorer or verifier without using this repository's code.
The test vectors at the end are checked by `npm test` against both implementations here: the Node.js service and
the Python verifier.

## 1. The transaction

An anchor is one validated XRPL transaction that meets all of these:

- **Type:** `TransactionType` is `AccountSet`. It sets no flags. The only exception is that it MAY set the
  account's `Domain`, which the service does on the first anchor.
- **Result:** the transaction validated with `tesSUCCESS`.
- **Account:** `Account` is the declared anchor account.
- **Memo:** it carries exactly one memo whose `MemoType`, decoded from hex as UTF-8, equals the deployment's memo
  type. Other memos may be present and are ignored. Two memos of the anchor type make the transaction invalid
  (ambiguous).
- **Memo type:** 1 to 64 printable ASCII characters, with no space (`[\x21-\x7e]{1,64}`). The default is
  `xrpl-git-anchor/v1`. Each deployment should pick its own (e.g. `gradedlp/anchor/v1`).
- **Memo format:** `MemoFormat` decodes to `application/json`.
- **Memo data:** `MemoData` decodes to the canonical JSON of the record in §2.

The anchor's time is the close time of the validated ledger that contains it (`date`, in seconds since
2000-01-01T00:00:00Z). That close time is the only time an anchor vouches for.

## 2. The memo record

```
{"commit":…,"files":…,"ref":…,"repo":…,"src":…,"tree_sha256":…,"v":1}
```

| key | type | rule |
|---|---|---|
| `v` | integer | `1` |
| `repo` | string | `https://` URL of the repository, 1–200 printable ASCII after the scheme |
| `ref` | string | branch name, `[A-Za-z0-9._/-]{1,64}` |
| `commit` | string | the anchored commit id: 40 lowercase hex (SHA-1 repository) or 64 (SHA-256 repository) |
| `tree_sha256` | string | TREE_V1 of that commit (§3), 64 lowercase hex |
| `files` | integer | number of entries TREE_V1 hashed |
| `src` | string | label of the source the commit was fetched from, `[a-z0-9][a-z0-9-]{0,15}` |

No other keys are allowed. **Canonical JSON** means:

- keys sorted by code point;
- no whitespace;
- integers written in plain decimal;
- strings in printable ASCII only (`\x20-\x7e`), escaped as JSON requires.

(In Python, this is `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`.)

**A verifier MUST reject the memo if any of these hold:**

- re-encoding the parsed object does not give back exactly the bytes on the ledger;
- the memo has unknown keys, or is missing any;
- `v` is not `1`.

## 3. TREE_V1

Input: a commit in a git repository. For every entry of `git ls-tree -r -z --full-tree <commit>`, emit one
line, chosen by the entry's type:

| entry | line |
|---|---|
| blob (regular file, executable, or symlink) | `<mode> <sha256 of the blob bytes, lowercase hex> <path>\n` |
| commit (submodule / gitlink) | `<mode> gitlink:<oid> <path>\n` |

- `<mode>` is git's octal mode as printed (`100644`, `100755`, `120000`, `160000`).
- `<path>` is the raw path bytes from git, which is UTF-8 in practice. It is not quoted and not normalised.
- A symlink's blob is its target path.

Sort the lines by raw path bytes (bytewise, not locale order). Then
`tree_sha256 = sha256(concatenation of all lines)`, and `files` is the number of lines.

Any other entry type is an error. `ls-tree -r` never emits trees, so an empty directory contributes nothing.

### What TREE_V1 covers and what it does not

**It covers** the path, the mode and the exact bytes of every tracked file in the commit.

**It does not cover:**

- **Submodule contents.** Only the pinned submodule commit id is covered; anchor the submodule's repository too
  if its contents matter.
- **Commit metadata:** message, author, dates, parents. These are bound only through the git `commit` id
  carried next to `tree_sha256` in the memo.
- **Untracked or ignored files.**
- **Git LFS objects.** Only their pointer files are covered.

**Why SHA-256.** Git object ids are SHA-1 in most repositories. Git uses a hardened SHA-1 that detects the
published collision attacks. However, SHA-1 is deprecated for long-lived commitments, and an anchor is meant to
be checked years from now. TREE_V1 recomputes every file with SHA-256, independently of git's own hashes.

**Same result in either object format.** For a tree without submodules, TREE_V1 is identical whether the
repository uses SHA-1 or SHA-256 objects (see vector 1).

## 4. Verification

**For each anchor transaction of the declared account carrying the memo type:**

1. **Check the transaction.** It must be validated, a `tesSUCCESS` `AccountSet`, with a well-formed canonical
   memo (§1–2). If not, the result is **FAIL**.
2. **Find the commit.** If `commit` is not in the verifier's clone, the result is **MISSING**. MISSING is not
   proof of tampering. A shallow or out-of-date clone gives it too, so run `git fetch` (or
   `git fetch --unshallow`) first. A rewritten history gives MISSING for every anchor from before the rewrite.
3. **Recompute TREE_V1.** If `(tree_sha256, files)` matches, the result is **VERIFIED**; otherwise it is
   **FAIL**.

**What a VERIFIED anchor proves.** Every file in that commit existed with exactly those bytes no later than the
ledger close time.

**The earliest proof of a file** is the earliest VERIFIED anchor whose commit holds a blob with the same bytes
at that path.

## 5. Threat model

- **No backdating.** Nobody can backdate an anchor, including the key holder: XRPL ledger close times only move
  forward, and validated transactions cannot be altered or removed.
- **A stolen key can only add new anchors.**
  - Each new anchor is stamped with the time it is sent.
  - Because every anchor is an upper bound, an extra anchor can never make a file look older than it is.
  - Anchors naming commits outside the repository verify as MISSING or FAIL.
  - The same key could also spend the account's XRP, set a RegularKey or disable the master key.
- **Responding to a compromise:**
  - sweep the account;
  - declare a new account in the same places as the old one (`Domain`, `xrp-ledger.toml`, the repository's
    README);
  - publish the date of the compromise.
  
  Anchors from the old account after that date should not be treated as the operator's.
- **Timing.** A commit is anchored by the first run after it reaches the branch: normally within the timer
  period, later if the service, the network or the fee cap delays it. Anchoring late is possible; anchoring
  early is not. Any reader can compare a file's earliest anchor with the time it was claimed to exist.
- **Repo identity.** `repo` is a label written by the operator. It does not prove where the commit lives. Pin
  the expected URLs with `--expect-repo`, and check the repository's own declaration of the anchor account.

## 6. Versioning

- **Within v1:** v1 is frozen. A new required field, or a change to the hash, means `"v": 2` and a new memo type
  suffix (e.g. `…/v2`).
- **Old anchors:** v1 anchors stay verifiable forever.
- **Verifiers:** a verifier must not accept a version it does not implement.

## 7. Test vectors

### Vector 1: four files, no submodule

The commit tree contains:

| path | mode | content | sha256(content) |
|---|---|---|---|
| `README.md` | 100644 | `hello\n` | `5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03` |
| `a b/ü.txt` | 100644 | (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `bin/run.sh` | 100755 | `#!/bin/sh\necho hi\n` | `299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba` |
| `link` | 120000 | symlink to `README.md` | `b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5` |

`tree_sha256 = 9c10998a59d538b51cc6fe82246ea54b6b45217537bf6100acf08b8bf77a8b18`, `files = 4`. The result is the
same in a SHA-1 and a SHA-256 repository.

### Vector 2: vector 1 plus a submodule

Add a submodule `sub` at commit `1111111111111111111111111111111111111111` (mode 160000).

`tree_sha256 = 9bbd03f50eb286c449a588e04f29827ddac343405b3b21da4e6032077b66db3d`, `files = 5`.

### Vector 3: canonical memo

Fields: `repo=https://example.org/demo/repo`, `ref=main`, `commit=a×40`, `tree_sha256=b×64`, `files=12`,
`src=github`.

- `MemoData` (decoded):
  `{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":12,"ref":"main","repo":"https://example.org/demo/repo","src":"github","tree_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","v":1}`
- `MemoType` (hex, default type): `7872706C2D6769742D616E63686F722F7631`
- `MemoFormat` (hex): `6170706C69636174696F6E2F6A736F6E`

### Reproducing vector 1 without git

```python
import hashlib
h = lambda b: hashlib.sha256(b).hexdigest()
lines = [("100644", b"hello\n", "README.md"), ("100644", b"", "a b/ü.txt"),
         ("100755", b"#!/bin/sh\necho hi\n", "bin/run.sh"), ("120000", b"README.md", "link")]
print(h(b"".join(f"{m} {h(c)} {p}\n".encode() for m, c, p in lines)))   # 9c10998a…
```
