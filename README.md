# xrpl-git-anchor

Anchor any git repository to the XRP Ledger, and verify it independently.

A git commit date is whatever its author typed. An XRP Ledger close time isn't. `xrpl-git-anchor` watches
one branch of a repository and, whenever it moves, sends one small transaction whose memo carries the
commit id and a SHA-256 over every file in that commit. From then on, anyone with a clone can prove that
each of those files existed, byte for byte, no later than that ledger's close time. Nobody can backdate
it, including the operator.

- **Anchor service** (Node.js, one dependency: [`xrpl`](https://www.npmjs.com/package/xrpl)): a systemd
  oneshot plus timer, crash-safe, with the key held as a systemd credential.
- **Verifier** (`verify/verify_anchor.py`, Python standard library plus `git`): reads the anchors straight
  from public XRPL nodes and recomputes every hash from your own clone. It trusts nothing the operator serves.

It has run in production since 2026-09-25 for [GradedLP](https://gradedlp.com). GradedLP anchors its public
forecast record, [GradedLP/publiciq](https://github.com/GradedLP/publiciq), every 30 minutes when the record
changes; that is over 230 anchors so far at about 12 drops each. You can check all of them yourself:

    git clone https://github.com/GradedLP/publiciq.git
    python3 verify/verify_anchor.py --repo publiciq --account rPUig22h1mAiCsiRT2C9TGpqotHGCS8Y3K \
        --memo-type gradedlp/anchor/v1
    python3 verify/verify_anchor.py --repo publiciq --account rPUig22h1mAiCsiRT2C9TGpqotHGCS8Y3K \
        --memo-type gradedlp/anchor/v1 --file ANCHORS.md      # earliest ledger proving this exact file

## What it is for

Anything where "this existed, unchanged, by time T" matters and you don't want the reader to have to trust
you: pre-registered forecasts and study protocols, research data releases, audit logs, prior-art and
design records, changelogs, policy documents, software releases.

## What an anchor proves, and what it doesn't

**It proves:** every file in the anchored commit existed with exactly those bytes no later than the close
time of the ledger that holds the transaction.

**It does not prove:**

- that a file did not exist earlier (you only get an upper bound);
- who wrote it;
- that the content is true.

It does not stop the operator from anchoring late. What it does is make lateness visible: any reader can compare
a file's earliest anchor with when it was claimed to exist.

A commit is anchored by the first run after it reaches the branch. That is normally within 30 minutes, and
later if the service, the network or the fee cap delays it.

If the repository's history is rewritten, the old anchors stay on the ledger and the verifier reports their
commits as MISSING. The service also raises an urgent alert.

What is and is not covered, in full: [SPEC.md](SPEC.md) (the format, TREE_V1's coverage, the threat model and test
vectors).

## The record (stable format, so others can implement it)

**One `AccountSet` transaction (a no-op, except that the first anchor may set the account's `Domain`), carrying exactly one memo of the deployment's memo type:**

| Field | Value |
|---|---|
| `MemoType` | default `xrpl-git-anchor/v1`; configurable per deployment (e.g. `gradedlp/anchor/v1`) |
| `MemoFormat` | `application/json` |
| `MemoData` | canonical JSON (keys sorted, no whitespace, ASCII only) of `{"commit","files","ref","repo","src","tree_sha256","v":1}` |

- `commit` is the git commit id (SHA-1, or SHA-256 for SHA-256 repositories).
- `files` is the number of tree entries.
- `ref` is the branch.
- `repo` is the repository URL.
- `src` is which configured source the commit was fetched from.

The verifier re-encodes the parsed memo and rejects it if the bytes on the ledger are not canonical.

**`tree_sha256` (TREE_V1).** Most git repositories use SHA-1 object ids. Git's SHA-1 is hardened against the
published collision attacks, but SHA-1 is deprecated for long-lived commitments, and an anchor is meant to be
checked years from now. TREE_V1 therefore re-hashes every file with SHA-256, independently of git's own hashes:

    for each entry of `git ls-tree -r -z --full-tree <commit>`:
      blob    -> "<mode> <sha256(file bytes)> <path>\n"
      gitlink -> "<mode> gitlink:<oid> <path>\n"
    sort the lines by raw path bytes; tree_sha256 = sha256(all lines concatenated)

**Coverage.** TREE_V1 covers the path, mode and exact bytes of every tracked file. It does not cover:

- the contents of a submodule (only its pinned commit id);
- commit metadata (message, author, dates), which is bound only by the git commit id in the memo;
- untracked files;
- Git LFS objects (only their pointer files).

For a tree without submodules, TREE_V1 gives the same value in SHA-1 and SHA-256 repositories.

**Two independent implementations.** The Node service and the Python verifier implement TREE_V1 separately. The
tests pin that both reproduce the published test vectors in [SPEC.md](SPEC.md), and that they agree on awkward
paths: spaces, unicode, executable bits, symlinks, submodules, empty files, and the `a-b` / `a.b` / `a/b` ordering
traps.

## Verify (anyone)

    git clone <repo URL> repo
    python3 verify_anchor.py --repo repo --account <rANCHOR> [--memo-type <type>]   # every anchor
    python3 verify_anchor.py --repo repo --account <rANCHOR> --file path/to/file     # earliest proof of these bytes
    python3 verify_anchor.py --repo repo --account <rANCHOR> --tx <HASH>             # one anchor
    python3 verify_anchor.py --repo repo --toml https://example.org/.well-known/xrp-ledger.toml   # account from a toml
    python3 verify_anchor.py --repo repo --tree <COMMIT>                             # just compute tree_sha256

Each anchor is reported as one of:

- `VERIFIED`: the tree recomputes and matches.
- `FAIL`: not a validated `tesSUCCESS` AccountSet, a malformed or non-canonical memo, a tree mismatch, or a
  repo URL not listed in `--expect-repo`.
- `MISSING`: the commit is not in your clone. Usually that means the clone is shallow or out of date: run
  `git fetch` or `git fetch --unshallow`, and the verifier warns about shallow clones. After a history rewrite,
  every anchor from before the rewrite is MISSING. MISSING alone is not proof of tampering; FAIL is.

The exit code is 0 only when everything checked verified. Add `--json` for machine output. Use
`--expect-repo URL` (repeatable) to pin which repo URLs the memos may name. After a repository transfer, list
both the old and the new URL.

Check the anchor account against the operator's own declarations: the account's `Domain` field, their
`/.well-known/xrp-ledger.toml`, and the repository's README.

## Run your own (testnet first)

Requirements: Linux with systemd, Node.js ≥ 22.13, git, Python 3 (for verifying), and about 2 XRP on
mainnet (1 XRP base reserve plus fees). A testnet account is free from the faucet.

    sudo useradd --system --home /var/lib/xrpl-git-anchor --shell /usr/sbin/nologin xrpl-git-anchor
    sudo git clone https://github.com/GradedLP/xrpl-git-anchor.git /opt/xrpl-git-anchor
    cd /opt/xrpl-git-anchor && sudo npm ci --omit=dev && npm test

    sudo install -d -m 0700 /etc/xrpl-git-anchor
    sudo node bin/keygen.js /etc/xrpl-git-anchor/seed        # prints ADDRESS and PUBLIC_KEY only
    sudo cp deploy/xrpl-git-anchor.env.example /etc/xrpl-git-anchor.env   # set ANCHOR_REPO_URL, ANCHOR_ACCOUNT
    # fund ADDRESS (testnet: https://xrpl.org/resources/dev-tools/xrp-faucets)
    sudo cp deploy/xrpl-git-anchor.service deploy/xrpl-git-anchor.timer deploy/xrpl-git-anchor-alert.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl start xrpl-git-anchor.service && journalctl -u xrpl-git-anchor -n 20 --no-pager   # first anchor
    sudo systemctl enable --now xrpl-git-anchor.timer

Status (needs no seed, prints no secret):
`sudo -u xrpl-git-anchor env $(grep -v '^#' /etc/xrpl-git-anchor.env | xargs) STATE_DIRECTORY=/var/lib/xrpl-git-anchor node bin/status.js`.

Every 30 minutes, a run does the following:

1. Finishes any transaction a previous run left pending.
2. Fetches the branch into a private bare mirror. It tries `ANCHOR_REPO_URL` first and the optional
   `ANCHOR_FALLBACK_URL` second.
3. Computes `tree_sha256`.
4. Anchors only if the commit changed, or if the last anchor is older than `ANCHOR_HEARTBEAT_HOURS`
   (default 24). Otherwise it sends nothing.

All configuration is in `deploy/xrpl-git-anchor.env.example`. Pick your own `ANCHOR_MEMO_TYPE` (e.g.
`yourproject/anchor/v1`), so your anchors can be told apart from anyone else's.

With `ANCHOR_PUBLIC_DIR` set, every anchor also writes three files you can serve:

- `index.json`: every proof.
- `latest.json`: the newest proof.
- `files.json`: for each path, the earliest anchor holding each distinct version of the file.

These are convenience copies. The verifier never needs them.

## Keys

- **Key creation:** `keygen.js` creates the key on the server: an ed25519 key from the OS CSPRNG, written
  `0400` with `O_EXCL`. It refuses to overwrite an existing key, and it prints only the address and public key.
- **How the service reads the key:** systemd `LoadCredential` hands the key to the service for the length of
  one run. Boot refuses to start if any environment variable is seed-shaped or has a seed-like name, because
  environment variables leak into `systemctl show`, `/proc` and crash dumps.
- **If the key leaks:**
  - **What the key holder can do:** add new anchors, spend the account's XRP, or take the account over (set
    their own RegularKey, disable the master key).
  - **What they cannot do:** change or remove an anchor that already validated, or backdate anything. A new
    anchor carries the time it is sent, and every anchor is only an upper bound, so an extra anchor can never
    make a file look older than it is. Anchors naming commits that are not in the repository verify as MISSING
    or FAIL.
  - **What to do:** sweep the account, declare a new account where the old one was declared, and publish the
    compromise date. Anchors from the old account after that date are not yours.
- **If the server dies:** every anchor already on the ledger stays valid. Make a new key and declare it.
- **Recovering the XRP without ever seeing the seed:**
  - `bin/admin.js regular-key <your wallet address>` lets a wallet you hold (e.g. Xaman) sign for the account.
  - `bin/admin.js sweep <address> [--tag N]` sends everything above the reserve.
  - Both commands make you type the last 6 characters of the address first. They refuse typos, unactivated
    addresses, the account itself, and tagless exchange addresses.
  - `npm run e2e:admin` rehearses both on testnet.

## Crash safety

The signed transaction blob is written to `state.json` as `pending` before it is submitted. The next run
looks that exact hash up and does one of two things:

- if it validated, it records the proof;
- if it expired past its `LastLedgerSequence`, it drops it and anchors again.

So a crash between signing and confirmation can't produce a duplicate anchor or lose a proof. The tests simulate
a crash after submit, a dropped transaction, and a `tem` rejection.

Two limits:

- this relies on the state directory surviving the crash; if `state.json` itself is lost, the worst case is one
  extra anchor;
- `tem`/`tel` rejections consume nothing and are cleared at once.

RPC calls fail over across public nodes and back off when rate-limited.

## Alerts (optional, via [ntfy](https://ntfy.sh))

Alerts go out when:

- a run fails;
- the branch no longer descends from the last anchored commit (history rewritten). The old commit stays
  pinned in the mirror and on the ledger;
- the spendable balance falls under `ANCHOR_MIN_SPENDABLE_XRP`. This alert fires at most once a day.

## Tests

`npm test` runs offline. A fake rippled checks real signatures and keeps a ledger, so the following can all
be exercised without a network:

- crash recovery;
- expiry;
- fee spikes;
- history rewrites;
- the Python verifier, end to end, including tamper detection.

The published test vectors in [SPEC.md](SPEC.md) are checked against both implementations, in SHA-1 and SHA-256
repositories. `npm run e2e:testnet` does a live, faucet-funded testnet anchor of any public repository
(`E2E_REPO_URL`) and verifies it from public nodes.

## Cost

About 12 drops per anchor. At 48 anchors a day that is under 0.25 XRP a year. The base reserve (currently
1 XRP) stays locked in the account.

## License

MIT. See [LICENSE](LICENSE).
