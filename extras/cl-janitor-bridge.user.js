// ==UserScript==
// @name         Character Library - JanitorAI Bridge
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      1.0.2
// @description  Lets Character Library browse JanitorAI (hampter) results reliably by making the Cloudflare-gated request from your own browser.
// @author       Sillyanonymous
// @match        *://*/*
// @connect      janitorai.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * A page fetch from Character Library to janitorai.com can read the response (hampter serves
 * CORS *) but cannot send your janitorai cf_clearance cookie (credentialed requests are rejected
 * against a * ACAO), so it only gets through when Cloudflare isn't actively challenging.
 * GM_xmlhttpRequest is CORS-exempt: it carries your cf_clearance cookie, so the request passes
 * Cloudflare reliably. That cookie is the ONLY thing this script uniquely adds. It also forwards
 * the Authorization header CL provides, but that is just the request riding along intact: the
 * JanitorAI login (which unlocks page 2+ of these sorts) is a CORS-allowed header the direct
 * fetch sends too, so login works with or without this script.
 *
 * SECURITY
 * This script is a privileged context (GM_xmlhttpRequest can reach the network with your cookies),
 * so it is deliberately locked down:
 *   - It ONLY ever requests https://janitorai.com/hampter/... with GET. Any other URL or method is
 *     refused, so even a compromised CL page cannot use it to read your cookies from another site.
 *   - It only answers same-origin messages (event.origin check) tagged by CL.
 *   - @connect janitorai.com makes the userscript manager enforce the host boundary too.
 * It never sends anything anywhere except the janitorai hampter request CL asks for, and returns
 * only that response body back to the CL page in the same tab.
 */

(function () {
    'use strict';

    const PAGE_SRC = 'character-library';
    const SCRIPT_SRC = 'cl-janitor-bridge';

    // Only run on the Character Library page (the manifest @match is broad; this narrows it without
    // needing to know the user's SillyTavern host). CL announces itself with a page marker.
    const isCLPage = /\/SillyTavern-CharacterLibrary\/app\/library\.html/i.test(location.pathname)
        || !!document.querySelector('meta[name="character-library"]');
    if (!isCLPage) return;
    console.debug('[CL-JanitorBridge] active on Character Library page');

    // Hard allowlist: the ONLY thing this bridge is permitted to fetch.
    const ALLOWED_PREFIX = 'https://janitorai.com/hampter/';
    function isAllowed(url) {
        if (typeof url !== 'string' || !url.startsWith(ALLOWED_PREFIX)) return false;
        try {
            return new URL(url).hostname === 'janitorai.com';
        } catch {
            return false;
        }
    }

    const gmRequest = (typeof GM_xmlhttpRequest === 'function')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    function reply(id, ok, status, body) {
        window.postMessage({ source: SCRIPT_SRC, type: 'result', id, ok, status, body }, location.origin);
    }

    function announce() {
        window.postMessage({ source: SCRIPT_SRC, type: 'ready' }, location.origin);
    }

    window.addEventListener('message', (e) => {
        // Origin-guarded rather than e.source === window: under an Xray wrapper the sandbox window
        // is not identity-equal to the page window, so the identity check would drop every message.
        if (e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || msg.source !== PAGE_SRC) return;

        if (msg.type === 'ping') {
            announce();
            return;
        }
        if (msg.type !== 'fetch') return;

        const { id, url, authToken } = msg;
        if (!id) return;
        if (!gmRequest) { reply(id, false, 0, 'Userscript manager does not expose GM_xmlhttpRequest'); return; }
        if (!isAllowed(url)) { reply(id, false, 0, 'Blocked: bridge only permits JanitorAI hampter requests'); return; }

        const headers = { 'Accept': 'application/json' };
        if (typeof authToken === 'string' && authToken) headers['Authorization'] = `Bearer ${authToken}`;

        gmRequest({
            method: 'GET',
            url,
            headers,
            timeout: 20000,
            onload: (r) => reply(id, r.status >= 200 && r.status < 300, r.status, r.responseText || ''),
            onerror: () => reply(id, false, 0, 'Network error'),
            ontimeout: () => reply(id, false, 0, 'Timed out'),
        });
    });

    // Announce on load; CL also pings, so the handshake works whichever side is ready first.
    announce();
})();
