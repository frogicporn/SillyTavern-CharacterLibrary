// JanitorAI userscript bridge (optional reliable transport for hampter browse).
//
// A cross-origin fetch from CL's page can READ hampter (it serves CORS *) but cannot send
// janitorai's cf_clearance cookie: credentialed requests are rejected against a * ACAO, so the
// direct fetch only gets through when Cloudflare isn't actively challenging, and no server-side
// fetcher can carry the cookie at all. The optional companion userscript
// (extras/cl-janitor-bridge.user.js) closes the gap: GM_xmlhttpRequest is CORS-exempt, so it
// carries the cf_clearance cookie and passes Cloudflare reliably. It forwards the Authorization
// header too, but thats orthogonal: the Bearer is a CORS-allowed header the direct fetch also
// sends, so login (page 2+ of these sorts) works on either transport.
//
// This module is a pure postMessage transport. The token lifecycle stays in datacat-provider
// (window.janitorai*), which mints fresh access tokens off the CORS-open Supabase auth endpoint.
// Nothing here runs unless the userscript announces itself, so non-users pay nothing.

const PAGE_SRC = 'character-library';
const SCRIPT_SRC = 'cl-janitor-bridge';
const REQUEST_TIMEOUT_MS = 25000;

let bridgeReady = false;
let initialized = false;
const pending = new Map(); // requestId -> { resolve, timer }

function handleMessage(e) {
    // Origin-guarded, not e.source === window: the userscript runs behind an Xray wrapper (Firefox),
    // so its window is not identity-equal to the page's; origin is the reliable cross-context check.
    if (e.origin !== window.location.origin) return;
    const msg = e.data;
    if (!msg || msg.source !== SCRIPT_SRC) return;

    if (msg.type === 'ready') {
        if (!bridgeReady) console.debug('[CL] JanitorAI userscript bridge connected');
        bridgeReady = true;
        return;
    }
    if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve({ ok: !!msg.ok, status: msg.status || 0, body: typeof msg.body === 'string' ? msg.body : '' });
    }
}

export function initJanitorBridge() {
    if (initialized) return;
    initialized = true;
    window.addEventListener('message', handleMessage);
    // Handshake is symmetric: the userscript announces 'ready' on load, and this ping re-triggers
    // that announce in case the userscript was already listening before CL attached the handler.
    window.postMessage({ source: PAGE_SRC, type: 'ping' }, window.location.origin);
}

export function isJanitorBridgeAvailable() {
    return bridgeReady;
}

// Resolves { ok, status, body } with body as the raw response text, or rejects on transport
// failure (no bridge / timeout) so callers can fall back to the best-effort direct fetch.
export function janitorBridgeFetch(url, authToken = '') {
    return new Promise((resolve, reject) => {
        if (!bridgeReady) {
            reject(new Error('JanitorAI bridge not available'));
            return;
        }
        const id = `clj_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('JanitorAI bridge request timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        window.postMessage({ source: PAGE_SRC, type: 'fetch', id, url, authToken }, window.location.origin);
    });
}
