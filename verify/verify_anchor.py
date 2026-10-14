#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Nathen Wright, operating as GradedLP. Part of xrpl-git-anchor.
"""verify_anchor.py - independently verify XRPL anchors of a git repository (xrpl-git-anchor).

Standard library only (plus the `git` command). Nothing here trusts the anchoring service: the anchors
are read straight from public XRP Ledger nodes and every tree hash is recomputed from YOUR clone.

    git clone <repo URL> repo
    python3 verify_anchor.py --repo repo --account rANCHOR...                       # verify every anchor
    python3 verify_anchor.py --repo repo --account rANCHOR... --file path/x.json    # earliest ledger time proving this file
    python3 verify_anchor.py --repo repo --account rANCHOR... --tx <HASH>           # one anchor
    python3 verify_anchor.py --repo repo --toml https://example.org/.well-known/xrp-ledger.toml   # account from the toml

What an anchor proves: an XRPL transaction from the anchor account, in a ledger that closed at time T,
carries a memo naming a commit and a SHA-256 over every file in it (tree_sha256). Ledger close times
cannot be backdated, so every file in that commit existed, byte for byte, no later than T.
Git commit dates are set by the author and prove nothing; this does.

tree_sha256 (TREE_V1): for every entry of `git ls-tree -r -z --full-tree <commit>`, the line
"<mode> <sha256 of the file bytes> <path>\\n" (a submodule is "<mode> gitlink:<oid> <path>\\n"),
lines sorted by raw path bytes, then SHA-256 over all lines. It is re-hashed with SHA-256 because git's
own SHA-1 ids are not collision-safe.

Each deployment uses its own memo type (default xrpl-git-anchor/v1; pass --memo-type for others, e.g.
gradedlp/anchor/v1). Check the anchor account against the operator's own declarations (their
xrp-ledger.toml, the account's Domain field, the repository's README).
Exit code 0 = everything checked verified.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.request

DEFAULT_MEMO_TYPE = "xrpl-git-anchor/v1"
MEMO_FORMAT = "application/json"
RIPPLE_EPOCH = 946684800
RPC = {
    "mainnet": ["https://xrplcluster.com/", "https://s1.ripple.com:51234/", "https://s2.ripple.com:51234/"],
    "testnet": ["https://s.altnet.rippletest.net:51234/", "https://testnet.xrpl-labs.com/"],
}
UA = "xrpl-git-anchor-verify/1"
MEMO_KEYS = {"v", "repo", "ref", "commit", "tree_sha256", "files", "src"}


# ---------------------------------------------------------------- git / TREE_V1
def git(repo, *args, input_bytes=None):
    r = subprocess.run(["git", "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-C", repo, *args],
                       input=input_bytes, capture_output=True)
    return r


def has_commit(repo, commit):
    return git(repo, "cat-file", "-e", commit + "^{commit}").returncode == 0


def tree_sha256(repo, commit, cache=None):
    cache = {} if cache is None else cache
    r = git(repo, "ls-tree", "-r", "-z", "--full-tree", commit)
    if r.returncode != 0:
        raise RuntimeError("git ls-tree failed: " + r.stderr.decode(errors="replace").strip())
    entries = []
    for rec in r.stdout.split(b"\0"):
        if not rec:
            continue
        meta, p = rec.split(b"\t", 1)
        mode, typ, oid = meta.decode("latin-1").split(" ")
        entries.append((p, mode, typ, oid))
    need = sorted({oid for _, _, typ, oid in entries if typ == "blob" and oid not in cache})
    if need:
        r = git(repo, "cat-file", "--batch", input_bytes=("\n".join(need) + "\n").encode())
        out, i = r.stdout, 0
        for want in need:
            nl = out.index(b"\n", i)
            oid, typ, size = out[i:nl].decode("latin-1").split(" ")
            if oid != want or typ != "blob":
                raise RuntimeError("cat-file: unexpected object %s %s" % (oid, typ))
            n = int(size)
            cache[oid] = hashlib.sha256(out[nl + 1:nl + 1 + n]).hexdigest()
            i = nl + 1 + n + 1
    entries.sort(key=lambda e: e[0])
    h = hashlib.sha256()
    for p, mode, typ, oid in entries:
        if typ == "blob":
            fp = cache[oid]
        elif typ == "commit":
            fp = "gitlink:" + oid
        else:
            raise RuntimeError("unexpected entry type " + typ)
        h.update(("%s %s " % (mode, fp)).encode("latin-1") + p + b"\n")
    return h.hexdigest(), len(entries)


def blob_at(repo, commit, path):
    r = git(repo, "rev-parse", "-q", "--verify", "%s:%s" % (commit, path))
    return r.stdout.decode().strip() if r.returncode == 0 else None


# ---------------------------------------------------------------- ledger
class Rpc:
    def __init__(self, endpoints, timeout=20):
        self.endpoints, self.timeout = endpoints, timeout

    def call(self, method, **params):
        last = None
        params.setdefault("api_version", 1)
        for url in self.endpoints:
            try:
                req = urllib.request.Request(url, data=json.dumps({"method": method, "params": [params]}).encode(),
                                             headers={"content-type": "application/json", "user-agent": UA})
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    res = json.load(resp)["result"]
                if res.get("status") == "error" and res.get("error") in ("tooBusy", "noNetwork", "noCurrent", "slowDown"):
                    raise RuntimeError(res["error"])
                return res
            except Exception as e:  # noqa: BLE001 - try the next public node
                last = e
        raise RuntimeError("%s: all endpoints failed (%s)" % (method, last))


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def unhex(h):
    return bytes.fromhex(h or "").decode("utf-8")


def parse_memo(memos, memo_type=DEFAULT_MEMO_TYPE):
    found = [m.get("Memo", {}) for m in (memos or []) if unhex(m.get("Memo", {}).get("MemoType")) == memo_type]
    if len(found) != 1:
        return None, "expected exactly one anchor memo, found %d" % len(found)
    m = found[0]
    if unhex(m.get("MemoFormat")) != MEMO_FORMAT:
        return None, "memo format is not " + MEMO_FORMAT
    raw = unhex(m.get("MemoData"))
    try:
        obj = json.loads(raw)
    except ValueError:
        return None, "memo is not JSON"
    if not isinstance(obj, dict) or set(obj) != MEMO_KEYS or obj.get("v") != 1:
        return None, "memo keys/version wrong"
    if canonical(obj) != raw:
        return None, "memo bytes are not canonical"
    if not re.fullmatch(r"[0-9a-f]{64}", obj["tree_sha256"]) or not re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", obj["commit"]):
        return None, "memo commit/tree_sha256 malformed"
    return obj, None


def tx_fields(entry):
    """Normalise an account_tx / tx entry across rippled API v1 and v2."""
    tx = entry.get("tx_json") or entry.get("tx") or entry
    return {
        "hash": entry.get("hash") or tx.get("hash"),
        "account": tx.get("Account"), "type": tx.get("TransactionType"), "memos": tx.get("Memos"),
        "ledger_index": entry.get("ledger_index") or tx.get("ledger_index"),
        "date": tx.get("date", entry.get("date")),
        "validated": entry.get("validated", False),
        "result": (entry.get("meta") or entry.get("metaData") or {}).get("TransactionResult"),
        "sequence": tx.get("Sequence"),
    }


def account_anchors(rpc, account, memo_type=DEFAULT_MEMO_TYPE):
    out, marker = [], None
    while True:
        p = {"account": account, "ledger_index_min": -1, "ledger_index_max": -1, "forward": True, "limit": 200}
        if marker is not None:
            p["marker"] = marker
        res = rpc.call("account_tx", **p)
        if res.get("status") == "error":
            raise RuntimeError("account_tx: %s %s" % (res.get("error"), res.get("error_message", "")))
        for e in res.get("transactions", []):
            f = tx_fields(e)
            if f["account"] != account or not f["memos"]:
                continue
            if not any(unhex(m.get("Memo", {}).get("MemoType")) == memo_type for m in f["memos"]):
                continue
            out.append(f)
        marker = res.get("marker")
        if marker is None:
            return out


def iso(ripple_seconds):
    import datetime
    return datetime.datetime.fromtimestamp(ripple_seconds + RIPPLE_EPOCH, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def toml_account(url, network, match="anchor"):
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        text = r.read().decode()
    try:
        import tomllib
        accts = tomllib.loads(text).get("ACCOUNTS", [])
    except ImportError:  # Python < 3.11: tiny fallback parser for [[ACCOUNTS]] blocks
        accts = [dict(re.findall(r'^\s*(\w+)\s*=\s*"([^"]*)"', blk, re.M)) for blk in text.split("[[ACCOUNTS]]")[1:]]
    net = "main" if network == "mainnet" else "testnet"
    hits = [a["address"] for a in accts if match.lower() in a.get("desc", "").lower() and a.get("network", "main") == net]
    if len(hits) != 1:
        raise RuntimeError("expected exactly one %s account whose desc contains %r in %s, found %d" % (net, match, url, len(hits)))
    return hits[0]


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", help="path to a git clone of the anchored repository (git fetch it first)")
    ap.add_argument("--account", help="anchor account (classic r-address)")
    ap.add_argument("--toml", help="xrp-ledger.toml URL to read the anchor account from, instead of --account")
    ap.add_argument("--toml-match", default="anchor", help="with --toml: pick the [[ACCOUNTS]] entry whose desc contains this (default: anchor)")
    ap.add_argument("--memo-type", default=DEFAULT_MEMO_TYPE, help="memo type of this deployment (default: %s)" % DEFAULT_MEMO_TYPE)
    ap.add_argument("--expect-repo", action="append", metavar="URL",
                    help="FAIL any anchor whose memo names a repo URL not listed (repeatable, e.g. old and new URL after a repo transfer)")
    ap.add_argument("--network", choices=["mainnet", "testnet"], default="mainnet")
    ap.add_argument("--rpc", action="append", help="rippled JSON-RPC URL (repeatable; default: public nodes)")
    ap.add_argument("--tx", help="verify only this anchor tx hash")
    ap.add_argument("--file", help="repo path: report the EARLIEST anchor proving this file's current bytes")
    ap.add_argument("--at", default="HEAD", help="with --file: which commit's version of the file (default HEAD)")
    ap.add_argument("--allow-missing", action="store_true", help="don't fail on anchored commits absent from --repo")
    ap.add_argument("--tree", metavar="COMMIT", help="only print tree_sha256 + file count for COMMIT in --repo")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    if a.tree:
        if not a.repo:
            ap.error("--tree needs --repo")
        t, n = tree_sha256(a.repo, a.tree)
        print(json.dumps({"commit": a.tree, "tree_sha256": t, "files": n}) if a.json else "%s  %d files" % (t, n))
        return 0

    say = (lambda *m: print(*m, file=sys.stderr)) if a.json else print
    rpc = Rpc(a.rpc or RPC[a.network])
    if not a.account and not a.toml:
        ap.error("pass --account or --toml")
    account = a.account or toml_account(a.toml, a.network, a.toml_match)
    say("anchor account: %s (%s, memo type %s)" % (account, a.network, a.memo_type))
    try:
        info = rpc.call("account_info", account=account, ledger_index="validated")
        dom = unhex(info.get("account_data", {}).get("Domain"))
        say("account Domain: %s" % (dom or "(not set)"))
    except Exception as e:  # noqa: BLE001
        say("account Domain: lookup failed (%s)" % e)

    if a.repo and git(a.repo, "rev-parse", "--is-shallow-repository").stdout.strip() == b"true":
        say("WARNING: %s is a shallow clone; anchored commits outside it will show as MISSING. Run: git -C %s fetch --unshallow"
            % (a.repo, a.repo))
    anchors = account_anchors(rpc, account, a.memo_type)
    if a.tx:
        anchors = [x for x in anchors if (x["hash"] or "").upper() == a.tx.upper()]
        if not anchors:
            say("FAIL: tx %s is not an anchor from %s" % (a.tx, account))
            return 1
    anchors.sort(key=lambda x: (x["ledger_index"], x["sequence"] or 0))
    say("anchors on ledger: %d" % len(anchors))

    cache, results, bad = {}, [], 0
    for x in anchors:
        r = {"tx": x["hash"], "ledger": x["ledger_index"], "close_time": iso(x["date"]) if x["date"] is not None else None}
        memo, why = parse_memo(x["memos"], a.memo_type)
        if not x["validated"] or x["result"] != "tesSUCCESS" or x["type"] != "AccountSet":
            r["status"], r["why"] = "FAIL", "not a validated tesSUCCESS AccountSet (%s %s)" % (x["type"], x["result"])
        elif memo is None:
            r["status"], r["why"] = "FAIL", why
        elif a.expect_repo and memo["repo"] not in a.expect_repo:
            r.update(commit=memo["commit"], repo=memo["repo"])
            r["status"], r["why"] = "FAIL", "memo names repo %s, expected %s" % (memo["repo"], " or ".join(a.expect_repo))
        else:
            r.update(repo=memo["repo"], commit=memo["commit"], tree_sha256=memo["tree_sha256"], files=memo["files"], src=memo["src"])
            if not a.repo:
                r["status"] = "ON-LEDGER (tree not checked; pass --repo)"
            elif not has_commit(a.repo, memo["commit"]):
                r["status"] = "MISSING (commit not in --repo; git fetch?)"
                if not a.allow_missing:
                    bad += 1
            else:
                t, n = tree_sha256(a.repo, memo["commit"], cache)
                if (t, n) == (memo["tree_sha256"], memo["files"]):
                    r["status"] = "VERIFIED"
                else:
                    r["status"], r["why"] = "FAIL", "tree mismatch: recomputed %s/%d" % (t, n)
        if r["status"] == "FAIL":
            bad += 1
        results.append(r)
        if not a.json:
            print("  %-8s ledger %-10s %s  %s  %s" % (r["status"].split(" ")[0], r["ledger"], r["close_time"],
                                                    (r.get("commit") or "")[:12], r.get("why", "")))

    earliest = None
    if a.file:
        if not a.repo:
            ap.error("--file needs --repo")
        target = blob_at(a.repo, a.at, a.file)
        if not target:
            say("FAIL: %s does not exist at %s" % (a.file, a.at))
            return 1
        for r in results:
            if r["status"] == "VERIFIED" and blob_at(a.repo, r["commit"], a.file) == target:
                earliest = r
                break
        if earliest:
            say("\nPROVEN: %s (blob %s) existed no later than %s - XRPL ledger %s, tx %s"
                  % (a.file, target[:12], earliest["close_time"], earliest["ledger"], earliest["tx"]))
        else:
            say("\nNOT YET ANCHORED: no verified anchor contains %s with these bytes" % a.file)
            bad += 1

    if a.json:
        print(json.dumps({"account": account, "network": a.network, "memo_type": a.memo_type, "anchors": results, "earliest_for_file": earliest}, indent=2))
    verified = sum(1 for r in results if r["status"] == "VERIFIED")
    say("\n%s: %d verified, %d problem(s), %d total" % ("OK" if bad == 0 else "FAILED", verified, bad, len(results)))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
