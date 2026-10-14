'use strict';
// Minimal rippled JSON-RPC client over HTTPS with endpoint failover. No websocket state to lose:
// every step (account_info, fee, submit, tx) is a plain request, so a crash at any point is
// recoverable from the state file (see anchor.js "pending").

const ENDPOINTS = {
  mainnet: ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/'],
  testnet: ['https://s.altnet.rippletest.net:51234/', 'https://testnet.xrpl-labs.com/'],
};

class RpcError extends Error {
  constructor(method, result) {
    super(`${method}: ${result.error || 'error'}${result.error_message ? ' - ' + result.error_message : ''}`);
    this.code = result.error; this.result = result;
  }
}

// Public nodes rate-limit (HTTP 429 / 418 / 503). A pass over every endpoint that fails is retried
// after a backoff, so a busy public node delays a run instead of failing it.
function createRpc({ endpoints, fetchImpl = globalThis.fetch, timeoutMs = 15000, log = () => {}, retryDelaysMs = [2000, 6000, 15000] }) {
  if (!endpoints || !endpoints.length) throw new Error('rpc: no endpoints');
  let preferred = 0;
  async function call(method, params = {}) {
    let lastErr;
    for (let round = 0; round <= retryDelaysMs.length; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, retryDelaysMs[round - 1]));
      try { return await pass(method, params); } catch (e) { if (e instanceof RpcError) throw e; lastErr = e; }
    }
    throw lastErr;
  }
  async function pass(method, params) {
    let lastErr;
    for (let k = 0; k < endpoints.length; k++) {
      const i = (preferred + k) % endpoints.length;
      const url = endpoints[i];
      try {
        const res = await fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, params: [{ api_version: 1, ...params }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const r = body && body.result;
        if (!r) throw new Error('no result');
        // Server-side trouble -> try the next endpoint. Request-level errors are returned to the caller.
        if (r.status === 'error' && ['tooBusy', 'noNetwork', 'noCurrent', 'noClosed', 'amendmentBlocked', 'slowDown'].includes(r.error)) {
          throw new Error('server: ' + r.error);
        }
        preferred = i;
        if (r.status === 'error') throw new RpcError(method, r);
        return r;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        lastErr = e; log('warn', 'rpc_endpoint_failed', { url, method, error: e.message });
      }
    }
    throw new Error(`rpc ${method}: all endpoints failed (${lastErr && lastErr.message})`);
  }
  return { call, endpoints };
}

module.exports = { createRpc, RpcError, ENDPOINTS };
