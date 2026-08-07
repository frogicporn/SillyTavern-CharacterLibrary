// Provider Utilities - shared helpers used across all providers
//
// Contains network helpers, text utilities, image processing,
// and the import pipeline shared by all provider implementations.

import CoreAPI from '../core-api.js';

// ========================================
// CONSTANTS
// ========================================

export const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

export const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';

// Live mobile-mode check for handlers that branch per mode (html.cl-mobile, owned by the boot
// policy + the library-mobile lifecycle). Always evaluate at event time, never at listener-attach
// time: the browse modal listener guards never reset, so an attach-time snapshot goes stale when
// the mode flips mid-session.
export function isMobileMode() {
    return document.documentElement.classList.contains('cl-mobile');
}

// Jump the browse list to the top so a new result set doesnt strand the user mid-list; mobile only.
export function scrollBrowseListTop() {
    if (!isMobileMode()) return;
    const sc = document.querySelector('.gallery-content');
    if (sc) sc.scrollTop = 0;
}

// XSS gate for any third-party browse content rendered via innerHTML.
// Never bypass; never duplicate this config per-provider.
export const BROWSE_PURIFY_CONFIG = {
    // no style tag: a <style> in inline-rendered content is document-global and restyles the whole
    // app; fields that carry authored CSS render through the sandboxed iframe path instead
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
        'ul', 'ol', 'li', 'a', 'img', 'center', 'font',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'
    ],
    ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel',
        'width', 'height', 'loading', 'color', 'size', 'align'
    ],
    ALLOW_DATA_ATTR: false
};

// n shimmer rows, last two tapered so it reads as a paragraph not a bar block.
export function skeletonLines(n = 3) {
    if (n <= 0) return '';
    const out = [];
    for (let i = 0; i < n; i++) {
        const cls = i === n - 1 ? 'cl-skeleton-line shorter'
                  : i === n - 2 ? 'cl-skeleton-line short'
                  : 'cl-skeleton-line';
        out.push(`<div class="${cls}"></div>`);
    }
    return out.join('');
}

// A browse preview fills several heavy fields (each a safePurify(formatRichText(...)) on big
// third-party content); doing them in one frame is a long task that janks the open. deferRender runs
// one queued job per frame, and only for fields actually on screen: a job whose element is hidden
// (collapsed section) or below the fold is parked instead of built, and an IntersectionObserver
// re-queues it on first reveal. Content the user never scrolls to never pays the sanitize cost.
let _deferQueue = [];
let _deferRaf = 0;
const _deferParked = new WeakMap(); // el -> job, waiting for first reveal
let _deferIO = null;

// 200px lookahead so a slow scroll meets built content instead of a skeleton.
const DEFER_REVEAL_MARGIN = 200;

// In-layout + within (margin-padded) viewport. getClientRects() is empty for display:none but not
// for zero-height boxes, so still-empty containers (eg. alt-greeting bodies) count as visible.
function _deferOnScreen(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + DEFER_REVEAL_MARGIN && r.bottom > -DEFER_REVEAL_MARGIN;
}

function _deferReveal() {
    if (_deferIO) return _deferIO;
    _deferIO = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            _deferIO.unobserve(en.target);
            const job = _deferParked.get(en.target);
            if (job) { _deferParked.delete(en.target); _enqueueDeferJob(job); }
        }
    }, { rootMargin: `${DEFER_REVEAL_MARGIN}px` });
    return _deferIO;
}

function _pumpDefer() {
    _deferRaf = 0;
    const job = _deferQueue.shift();
    if (job && job.el && job.el.isConnected) {
        if (_deferOnScreen(job.el)) {
            const t0 = performance.now();
            // build jobs assign innerHTML; call jobs run a side effect (eg. append a sanitized iframe).
            try { if (job.run) job.run(); else job.el.innerHTML = job.build(); } catch { /* skip a field that fails */ }
            CoreAPI.debugLog(`[defer] ${(performance.now() - t0).toFixed(1)}ms`, job.el.id || job.el.className);
        } else {
            _deferParked.set(job.el, job);
            _deferReveal().observe(job.el);
        }
    }
    if (_deferQueue.length) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// Pace one job per frame, only for on-screen elements; park the rest until first reveal. Reusing the
// same element replaces its pending job (queued or parked), so re-opening the (shared) preview modal
// with a new card supersedes the prior card's pending work instead of briefly painting it.
function _enqueueDeferJob(job) {
    _deferParked.delete(job.el);
    const i = _deferQueue.findIndex(j => j.el === job.el);
    if (i !== -1) _deferQueue.splice(i, 1);
    _deferQueue.push(job);
    if (!_deferRaf) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// build() returns HTML assigned via `el.innerHTML` in the pump (a text field's sanitize pipeline).
export function deferRender(el, build) {
    if (!el || typeof build !== 'function') return;
    _enqueueDeferJob({ el, build });
}

// run() runs a side-effecting callback in the pump instead of assigning innerHTML, for renders that
// append nodes themselves (eg. renderCreatorNotesSecure's sanitized iframe). Same pacing + parking.
export function deferCall(el, run) {
    if (!el || typeof run !== 'function') return;
    _enqueueDeferJob({ el, run });
}

// ========================================
// NETWORK
// ========================================

const _proxyOrigins = new Set();

// Short human snippet from an error body: JSON detail/message/error fields
// when present, else the tag-stripped raw start. Capped at 200 chars.
function errorSnippetFromText(text) {
    const t = (text || '').trim();
    if (!t) return '';
    try {
        const j = JSON.parse(t);
        const msg = j?.detail || j?.message || j?.error;
        if (typeof msg === 'string' && msg) return `: ${msg.slice(0, 200)}`;
        if (msg) return `: ${JSON.stringify(msg).slice(0, 200)}`;
    } catch { /* not JSON; fall through to raw */ }
    return `: ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

// Cloudflare interstitial signatures (block page, JS challenge, managed challenge)
export function isCloudflareBlockPage(text) {
    return /Attention Required! \| Cloudflare|cf-error-details|Just a moment|__cf_chl/i.test((text || '').slice(0, 2000));
}

// Recognizable error-page signatures get an actionable message, else null.
// Exported for transports that never hold a Response object: janitorai's hampter chain returns
// a plain {ok, status, body} from whichever of its three legs answered, so it cannot use
// readJsonClassified but still needs the same classification.
export function classifyErrorPage(text, status) {
    const head = (text || '').slice(0, 2000);
    if (head.startsWith('CORS proxy is disabled')) {
        return 'CORS proxy is disabled. Set enableCorsProxy: true in SillyTavern\'s config.yaml and restart the server';
    }
    // Served as HTTP 200 HTML during upstream maintenance / load shedding.
    if (/JanitorAI\s*-\s*Waiting Room/i.test(head)) {
        return 'JanitorAI is in its waiting room (high load or maintenance). This clears on their side; retry in a minute';
    }
    if (isCloudflareBlockPage(head)) {
        return `Cloudflare blocked this request from your SillyTavern server (HTTP ${status})`;
    }
    return null;
}

// The status/bodySnippet fields feed the copy-diagnostics report on browse error banners
function classifiedError(message, status, text) {
    const err = new Error(message);
    err.classified = true;
    err.status = status;
    err.bodySnippet = (text || '').slice(0, 300);
    return err;
}

function httpFailureError(status, text) {
    const pageMsg = classifyErrorPage(text, status);
    const err = classifiedError(pageMsg || `HTTP ${status}${errorSnippetFromText(text)}`, status, text);
    // Real auth statuses only, never a classified block page: Cloudflare challenges commonly
    // arrive as 403 and must not masquerade as an expired token; 5xx stays untagged likewise.
    if (!pageMsg && (status === 401 || status === 403)) err.authFailed = true;
    return err;
}

/**
 * Encode a URL for the /proxy/ path. encodeURIComponent leaves the sub-delims
 * !'()* literal; some reverse proxies/WAFs 403 literal parens as injection
 * patterns (postimg "(1)" filenames are the common trigger), so escape them too.
 * @param {string} url
 * @returns {string}
 */
export function proxyEncode(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Fetch with automatic CORS proxy fallback.
 * Remembers origins that need proxying to avoid redundant direct attempts.
 * @param {string} url
 * @param {Object} [opts] - fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithProxy(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!_proxyOrigins.has(origin)) {
        let directResponse;
        try {
            directResponse = await fetch(url, opts);
        } catch (e) {
            if (e?.name === 'AbortError') throw e; // caller intent, not a CORS signal - must not poison the cache
            // fetch() rejects on CORS/network errors - fall through to proxy
            _proxyOrigins.add(origin);
        }
        if (directResponse) {
            if (!directResponse.ok) throw httpFailureError(directResponse.status, await directResponse.text().catch(() => ''));
            return directResponse;
        }
    }
    let r;
    try {
        r = await fetch(`/proxy/${proxyEncode(url)}`, opts);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        // Same-origin reject means ST itself is unreachable, not a provider problem
        throw classifiedError('Could not reach your SillyTavern server (connection dropped or ST is not running)', null, '');
    }
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        // ST's corsProxy middleware answers a bare sendStatus(500) when its own server-side
        // fetch failed (no route, DNS, VPN down); upstream 500s carry real bodies.
        if (r.status === 500 && t.trim() === 'Internal Server Error') {
            throw classifiedError(`Your SillyTavern server could not reach ${origin} (network, DNS, or VPN problem)`, 500, t);
        }
        // A Cloudflare-blocked proxy leg is unrecoverable server-side; evict the origin so
        // the next call retries the browser-direct leg, which can pass where ST cannot.
        if (isCloudflareBlockPage(t)) _proxyOrigins.delete(origin);
        throw httpFailureError(r.status, t);
    }
    return r;
}

// ========================================
// BROWSE ERROR BANNER
// ========================================

let _envInfoPromise = null;
let _browseErrorDelegateWired = false;

// Gathered once per session, and only when someone actually clicks the report button
function gatherEnvInfo() {
    if (!_envInfoPromise) {
        _envInfoPromise = (async () => {
            const [manifest, helper, st, corsProxy] = await Promise.all([
                fetch('../manifest.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => null),
                (async () => {
                    try { return await (await CoreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`)).json(); } catch { return null; }
                })(),
                fetch('/version').then(r => r.json()).catch(() => null),
                // Probing with our own origin trips ST's circular-request check (400) when the
                // proxy is enabled, so nothing leaves the server; disabled answers a 404 + text.
                fetch(`/proxy/${proxyEncode(location.origin)}`).then(async r => {
                    if (r.status !== 404) return true;
                    const t = await r.text().catch(() => '');
                    return t.includes('CORS proxy is disabled') ? false : true;
                }).catch(() => null),
            ]);
            return {
                cl: manifest?.version || 'unknown',
                helper: helper?.ok ? `v${helper.version}` : 'absent',
                basicAuth: helper?.ok ? !!helper.basicAuth : null,
                st: st?.pkgVersion || 'unknown',
                corsProxy,
            };
        })();
    }
    return _envInfoPromise;
}

const onOff = (v) => (v === null || v === undefined ? 'unknown' : (v ? 'on' : 'off'));

async function buildBrowseErrorReport(c) {
    const env = await gatherEnvInfo();
    const err = c.error || {};
    const flags = Object.entries(c.flags || {}).map(([k, v]) => `${k}=${v}`).join(' | ');
    const lines = [
        `Character Library v${env.cl} browse error report (${c.time})`,
        `provider: ${c.provider} | view: ${c.view}`,
        `error: ${err.message || String(err)}`,
    ];
    if (err.status != null) lines.push(`http: ${err.status}`);
    if (err.bodySnippet) lines.push(`body: ${err.bodySnippet}`);
    if (flags) lines.push(`settings: ${flags}`);
    lines.push(`cl-helper: ${env.helper} | ST: ${env.st}`);
    lines.push(`env: corsProxy=${onOff(env.corsProxy)} | basicAuth=${onOff(env.basicAuth)} | lazyLoad=${onOff(CoreAPI.isStShallowMode())} | mode=${isMobileMode() ? 'mobile' : 'desktop'} | online=${onOff(navigator.onLine)}`);
    lines.push(`ua: ${navigator.userAgent}`);
    return lines.join('\n');
}

function wireBrowseErrorDelegate() {
    if (_browseErrorDelegateWired) return;
    _browseErrorDelegateWired = true;
    document.addEventListener('click', async (e) => {
        // Ctx rides the clicked banner itself: stale banners in hidden sections (eg. a
        // chub browse banner behind an open timeline) must not fire another view's retry.
        const ctx = e.target.closest('.browse-error-banner')?._browseErrorCtx;
        if (!ctx) return;
        if (e.target.closest('.browse-banner-retry')) {
            ctx.retry?.();
            return;
        }
        if (e.target.closest('.browse-banner-report')) {
            const ok = await CoreAPI.copyTextToClipboard(await buildBrowseErrorReport(ctx));
            CoreAPI.showToast(ok ? 'Error report copied to clipboard' : 'Could not copy to clipboard', ok ? 'success' : 'error');
        }
    });
}

/**
 * Render the canonical browse error banner into a grid; retry and the
 * copy-report button are armed by one shared document-level delegate.
 * flags must stay set/unset booleans; never token or cookie values.
 * @param {HTMLElement} grid
 * @param {Object} opts
 * @param {string} opts.provider - provider id for the report
 * @param {Error|Object} opts.error - ideally a readJsonClassified error (status/bodySnippet ride into the report)
 * @param {string} [opts.message] - display line, defaults to error.message
 * @param {string} [opts.title] - optional heading line
 * @param {string} [opts.view] - browse | timeline | favorites | creator, may carry a sort suffix
 * @param {Object} [opts.flags] - eg. { token: true, nsfw: false }
 * @param {Function} [opts.retry] - omit to render without a Retry button
 */
export function renderBrowseError(grid, { provider, error, message, title, view = 'browse', flags = {}, retry } = {}) {
    if (!grid) return;
    wireBrowseErrorDelegate();
    const esc = CoreAPI.escapeHtml;
    grid.innerHTML = `
        <div class="browse-error-banner">
            <i class="fa-solid fa-exclamation-triangle"></i>
            ${title ? `<h3>${esc(title)}</h3>` : ''}
            <p>${esc(message || error?.message || 'Unknown error')}</p>
            <div class="browse-error-actions">
                ${retry ? '<button class="glass-btn browse-banner-retry"><i class="fa-solid fa-redo"></i> Retry</button>' : ''}
                <button class="glass-btn browse-banner-report"><i class="fa-solid fa-copy"></i> Copy error report</button>
            </div>
        </div>
    `;
    const banner = grid.querySelector('.browse-error-banner');
    if (banner) banner._browseErrorCtx = { provider, error, view, flags, retry, time: new Date().toISOString() };
}

/**
 * Read a JSON-expected Response, classifying failures (ISP/Cloudflare error
 * pages, the disabled CORS proxy) into actionable errors instead of parser noise.
 * @param {Response} resp
 * @returns {Promise<any>}
 */
export async function readJsonClassified(resp) {
    const text = await resp.text().catch(() => '');
    if (resp.ok) {
        try { return JSON.parse(text); } catch { /* classified below */ }
    }
    throw !resp.ok
        ? httpFailureError(resp.status, text)
        : classifiedError(classifyErrorPage(text, resp.status)
            || `The provider returned an error page instead of data (HTTP ${resp.status})`, resp.status, text);
}

// ========================================
// TEXT UTILITIES
// ========================================

/**
 * Slugify a string for use in filenames and URL paths.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
    return (name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

/**
 * Decode common HTML entities without stripping tags. JanitorAI's listing endpoints
 * (Meili + Hampter) return creator-notes HTML escaped (&lt;p&gt;...&lt;/p&gt;) rather than
 * raw, so consumers expecting real HTML must decode first.
 * @param {string} s
 * @returns {string}
 */
export function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

/**
 * Strip HTML tags and decode common entities.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

/**
 * Rewrite root-relative media references in remote card text to the provider's site.
 * Covers markdown image destinations and <img src>; a single leading slash in remote
 * content can only mean site-relative, left alone the browser resolves it against the
 * ST origin and 404s (eg botbooru's ![](/mirror/<hash>.png) mirror rewrites).
 * Protocol-relative (//host) and absolute URLs pass through untouched.
 * @param {string} text
 * @param {string} base - provider site origin, eg 'https://botbooru.com'
 * @returns {string}
 */
export function absolutizeMediaPaths(text, base) {
    if (!text || !base) return text || '';
    const root = String(base).replace(/\/+$/, '');
    return String(text)
        .replace(/(!\[[^\]]*\]\()\/(?!\/)/g, (m, p1) => `${p1}${root}/`)
        .replace(/(<img\s[^>]*?src=["'])\/(?!\/)/gi, (m, p1) => `${p1}${root}/`);
}

// Pure-function memo: same raw name always normalizes the same, so a hit is never stale.
// Both consumers re-run it over stable inputs (library rebuild over allCharacters, per-card
// match checks over recurring browse names), so the cache erases the regex cost on repeats.
// FIFO-evict past the cap to bound a long browse session; dropping any entry is always safe.
const _normalizeBrowseNameCache = new Map();
const NORMALIZE_BROWSE_NAME_CACHE_CAP = 50000;

/**
 * Normalize a character name for cross-provider matching.
 * Strips version suffixes, common modifiers, and collapses whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeBrowseName(name) {
    if (!name) return '';
    const cached = _normalizeBrowseNameCache.get(name);
    if (cached !== undefined) return cached;
    const result = name
        .toLowerCase()
        .trim()
        .replace(/\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i, '')
        .replace(/\s*-?\s*v\d+(\.\d+)*$/i, '')
        .replace(/\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (_normalizeBrowseNameCache.size >= NORMALIZE_BROWSE_NAME_CACHE_CAP) {
        _normalizeBrowseNameCache.delete(_normalizeBrowseNameCache.keys().next().value);
    }
    _normalizeBrowseNameCache.set(name, result);
    return result;
}

/**
 * Format a number with K/M suffixes.
 * @param {number} num
 * @returns {string}
 */
export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// ========================================
// IMAGE PROCESSING
// ========================================

// Avatars ride inside the card PNG for the rest of its life, and the import re-encodes whatever
// arrives to lossless PNG, which inflates a compressed source several times over. SillyTavern's
// own canonical avatar is 512x768 and it never downscales on import, so an outsized one is paid
// for on the upload, on disk, and on every later decode.
//
// Budget by AREA rather than by long edge: a long-edge cap punishes extreme aspect ratios hardest,
// since a very tall card loses nearly all its width before its height comes into range, while an
// area budget bounds the decode and the re-encode the same way whatever the shape. The edge clamp
// is a separate backstop for panorama shapes, which can satisfy the area budget and still blow past
// what a canvas will allocate.
const MAX_AVATAR_PIXELS = 8_000_000;
const MAX_AVATAR_EDGE = 8192;

// PNG keeps its dimensions in the mandatory first chunk, so an oversized one is spotted
// without paying for a decode. null means unreadable, which keeps the untouched fast path.
function pngDimensions(buffer) {
    if (buffer.byteLength < 24) return null;
    const view = new DataView(buffer);
    if (view.getUint32(12) !== 0x49484452) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

// One policy shared by the passthrough check and the resize, so the two cannot drift apart.
function avatarScale(width, height) {
    if (!width || !height) return 1;
    return Math.min(
        1,
        Math.sqrt(MAX_AVATAR_PIXELS / (width * height)),
        MAX_AVATAR_EDGE / Math.max(width, height),
    );
}

/**
 * Ensure a buffer is PNG format, downscaled to a sane avatar size. Returns an already-PNG
 * buffer as-is unless it is oversized; otherwise converts via OffscreenCanvas with an
 * api.convertImageToPng fallback.
 * @param {ArrayBuffer} imageBuffer
 * @param {Object} [api] - CoreAPI reference for convertImageToPng fallback
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function ensurePng(imageBuffer, api) {
    // An empty or truncated body still resolves as a buffer, and the header read throws on it.
    if (!imageBuffer || imageBuffer.byteLength < 4) return null;

    const header = new Uint8Array(imageBuffer, 0, 4);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    if (isPng) {
        const dims = pngDimensions(imageBuffer);
        if (!dims || avatarScale(dims.width, dims.height) === 1) return imageBuffer;
    }

    try {
        const blob = new Blob([imageBuffer]);
        const bitmap = await createImageBitmap(blob);
        const scale = avatarScale(bitmap.width, bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        if (scale < 1) {
            CoreAPI.debugLog(`[ProviderUtils] avatar ${bitmap.width}x${bitmap.height} scaled to ${width}x${height}`);
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } catch (e1) {
        try {
            if (api?.convertImageToPng) return await api.convertImageToPng(imageBuffer);
        } catch (e2) {
            console.warn('[ProviderUtils] PNG conversion failed:', e2.message);
        }
    }
    return null;
}

/**
 * Generate a 256x256 dark gray placeholder PNG with a "?" character.
 * @returns {Promise<ArrayBuffer>}
 */
export async function generatePlaceholder() {
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#666';
    ctx.font = '100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 128, 128);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
}

// Post-import tail shared by every browse view: summary/preview choreography, success toast,
// library refresh, imported-badge stamp. The timings are deliberate: mobile shows the summary
// OVER the preview for 220ms (the small-viewport fade is too visible), the no-summary path
// flashes the button for 350ms, the refresh waits 200ms for ST to settle the upload, and a
// missed single-char add waits another 500ms before the full-list refetch.
export async function finishBrowseImport({ view, summaryArgs, showSummary, closePreview, importBtn, characterName, avatarFileName, markImported }) {
    if (showSummary) {
        if (isMobileMode()) {
            CoreAPI.showImportSummaryModal(summaryArgs);
            await new Promise(r => setTimeout(r, 220));
            closePreview();
        } else {
            closePreview();
            await new Promise(r => requestAnimationFrame(r));
            CoreAPI.showImportSummaryModal(summaryArgs);
        }
    } else {
        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
        await new Promise(r => setTimeout(r, 350));
        closePreview();
    }

    CoreAPI.showToast(`Imported "${characterName}"`, 'success');

    await new Promise(r => setTimeout(r, 200));
    // Lightweight single-character add (avoids OOM from a full list reload on mobile).
    const added = await CoreAPI.fetchAndAddCharacter(avatarFileName);
    if (added) {
        view.addCharToLookup(added);
    } else {
        await new Promise(r => setTimeout(r, 500));
        await CoreAPI.fetchCharacters(true);
    }
    markImported();
    // markImported only stamps the browse grid; this re-grade covers the mode-aware grids
    // (following/timeline included) and clears the card's stale possible-match badge.
    view.refreshInLibraryBadges?.();
}

/**
 * Assign gallery_id to a character card, inheriting from a replaced character
 * or generating a new one if the uniqueGalleryFolders setting is enabled.
 * @param {Object} card - V2 character card (mutated in place)
 * @param {Object} options
 * @param {string} [options.inheritedGalleryId] - gallery_id from a replaced character
 * @param {Object} api - CoreAPI reference
 */
export function assignGalleryId(card, options, api) {
    if (!card?.data?.extensions) return;
    if (options?.inheritedGalleryId) {
        card.data.extensions.gallery_id = options.inheritedGalleryId;
    } else if (api?.getSetting?.('uniqueGalleryFolders') && !card.data.extensions.gallery_id) {
        card.data.extensions.gallery_id = api.generateGalleryId?.();
    }
}

// ========================================
// IMPORT PIPELINE
// ========================================

// ST's import endpoint responds with the extensionless base name, while everything
// downstream (avatar lookups, /characters/get, folder resolution) keys on the real
// .png filename; canonicalize at the seam.
function ensurePngExt(name) {
    return /\.png$/i.test(String(name)) ? name : `${name}.png`;
}

/**
 * Shared import-to-SillyTavern pipeline. Handles PNG conversion, card
 * embedding, upload to ST's import endpoint, and result normalization.
 *
 * Providers call this after they've built their V2 card and downloaded
 * the avatar image. Provider-specific logic (metadata fetch, V2 card
 * building, link metadata, avatar download) stays in the provider.
 *
 * @param {Object} params
 * @param {Object} params.characterCard - V2 character card to embed
 * @param {ArrayBuffer|null} params.imageBuffer - avatar image (any format)
 * @param {string} params.fileName - target filename (e.g. "chub_slug.png")
 * @param {string} params.characterName - display name for toasts/results
 * @param {boolean} [params.hasGallery=false] - whether gallery images exist
 * @param {string|number|null} [params.providerCharId] - provider-side ID
 * @param {string|null} [params.fullPath] - canonical path on provider
 * @param {string|null} [params.avatarUrl] - remote avatar URL for display
 * @param {Object} params.api - CoreAPI reference
 * @returns {Promise<Object>} ProviderImportResult
 */
export async function importFromPng({
    characterCard,
    imageBuffer,
    fileName,
    characterName,
    hasGallery = false,
    providerCharId = null,
    fullPath = null,
    avatarUrl = null,
    api
}) {
    if (characterCard?.data?.name && characterCard.data.name.length > 128) {
        characterCard.data.name = characterCard.data.name.substring(0, 128).trimEnd();
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');

    let pngBuffer = await ensurePng(imageBuffer, api);
    imageBuffer = null;

    if (!pngBuffer) {
        pngBuffer = await generatePlaceholder();
    }

    let embeddedPng = api.embedCharacterDataInPng(pngBuffer, characterCard);
    pngBuffer = null;

    let file = new File([embeddedPng], safeName, { type: 'image/png' });
    embeddedPng = null;

    let formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', 'png');
    file = null;

    const csrfToken = api.getCSRFToken?.();
    console.log('[Import][debug] POST /api/characters/import csrfLen=' + (csrfToken || '').length);
    const importResponse = await fetch('/api/characters/import', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: formData
    });
    formData = null;

    const responseText = await importResponse.text();
    console.log('[Import][debug] /api/characters/import -> ' + importResponse.status + ' body=' + responseText.slice(0, 200));
    if (!importResponse.ok) throw new Error(`Import error: ${responseText}`);

    let result;
    try { result = JSON.parse(responseText); }
    catch { throw new Error(`Invalid JSON response: ${responseText}`); }
    if (result.error) throw new Error('Import failed: Server returned error');

    // ST's V2 import path runs data.name through sanitize-filename, replacing
    // path-illegal chars like '|' (creators use them as separators) with '_'.
    // merge-attributes does NOT re-sanitize, so we restore the raw name here.
    // Without this, update-checks flag false diffs against the remote and
    // gallery-folder lookups (using char.name) diverge from auto-localize's
    // raw-cardData folder.
    const ST_ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/;
    const rawName = characterCard.data?.name;
    if (result.file_name && rawName && ST_ILLEGAL_NAME_CHARS.test(rawName)) {
        // ST returns file_name without the extension; merge-attributes needs it.
        const avatarWithExt = ensurePngExt(result.file_name);
        let restoreOk = false;
        try {
            // CARVE-OUT from the "no direct merge-attributes" architectural rule: this fires during the import round-trip, before CL has the new char in its allCharacters list, so applyCardFieldUpdates' avatar lookup would fail. The write is a single scalar data.name field with no extension namespace involved, so no preflight or sentinel handling is needed.
            const resp = await api.apiRequest?.('/characters/merge-attributes', 'POST', {
                avatar: avatarWithExt,
                data: { name: rawName }
            });
            if (resp?.ok) {
                restoreOk = true;
            } else if (resp) {
                let body = '';
                try { body = await resp.clone().text(); } catch { /* ignore */ }
                console.warn(`[Import] data.name restore failed (HTTP ${resp.status}):`, body.slice(0, 200));
            }
        } catch (e) {
            console.warn('[Import] Failed to restore raw data.name:', e?.message || e);
        }
        if (!restoreOk) {
            api.showToast?.(`Imported "${characterName}" but couldn't restore special characters in the name; update checks may show false differences.`, 'warning', 6000);
        }
    }

    const mediaUrls = api.findCharacterMediaUrls?.(characterCard) || [];
    await CoreAPI.ensureExtractorsLoaded();
    const galleryPageUrls = CoreAPI.findCharacterGalleryUrls(characterCard);
    const galleryId = characterCard.data.extensions?.gallery_id || null;

    return {
        success: true,
        fileName: ensurePngExt(result.file_name || fileName),
        characterName: characterCard.data?.name || characterName,
        hasGallery,
        providerCharId,
        fullPath,
        avatarUrl,
        embeddedMediaUrls: mediaUrls,
        galleryPageUrls,
        galleryId,
        cardData: characterCard.data
    };
}

// ========================================
// GALLERY SAVE
// ========================================

/**
 * Resolve the stable filename identity for one gallery image.
 *
 * A provider that knows its media's identity supplies `name` directly; inferring from the
 * URL is only the fallback, because a CDN that ends the path in a variant word
 * (.../<id>/card) collapses every image onto that word. Every consumer of this identity
 * (fast-skip lookup, post-save index update, and the saved filename) MUST call this, or
 * the index gets keyed under a name the file was never saved with and later images
 * false-match the first one.
 * @param {Object} imageInfo - { url, name? }
 * @param {Object} api - CoreAPI reference
 * @returns {string}
 */
export function resolveGalleryMediaName(imageInfo, api) {
    if (imageInfo?.name) return api?.sanitizeMediaFilename?.(String(imageInfo.name)) || '';
    return api?.extractSanitizedUrlName?.(imageInfo?.url) || '';
}

/**
 * Save a downloaded media file to a character's gallery folder.
 * Uses the naming convention: {prefix}_{hash8}_{sanitizedName}.{ext}
 *
 * @param {Object} downloadResult - { arrayBuffer, contentType }
 * @param {Object} imageInfo - { url, id?, name?, nsfw? }
 * @param {string} folderName - gallery folder name
 * @param {string} contentHash - SHA-256 hash of the file content
 * @param {string} filePrefix - naming prefix (e.g. 'chubgallery')
 * @param {Object} api - CoreAPI reference
 * @returns {Promise<{success: boolean, localPath?: string, filename?: string, error?: string}>}
 */
export async function saveGalleryImage(downloadResult, imageInfo, folderName, contentHash, filePrefix, api) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        let extension = 'webp';
        if (contentType) {
            const mimeMap = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
                'audio/ogg': 'ogg', 'audio/flac': 'flac'
            };
            if (mimeMap[contentType]) extension = mimeMap[contentType];
            else if (contentType.startsWith('audio/')) extension = contentType.split('/')[1].split(';')[0].replace('x-', '') || 'audio';
        } else {
            const urlMatch = imageInfo.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) extension = urlMatch[1].toLowerCase();
        }

        const sanitizedName = resolveGalleryMediaName(imageInfo, api) || 'gallery_image';
        const shortHash = (contentHash?.length >= 8) ? contentHash.substring(0, 8) : 'nohash00';
        const filenameBase = `${filePrefix}_${shortHash}_${sanitizedName}`;

        let base64Data = api.arrayBufferToBase64?.(arrayBuffer);
        downloadResult.arrayBuffer = null;

        const bodyStr = JSON.stringify({
            image: base64Data,
            filename: filenameBase,
            format: extension,
            ch_name: folderName
        });
        base64Data = null;

        const csrfToken = api.getCSRFToken?.();
        const resp = await fetch(`/api${api.getEndpoints?.()?.IMAGES_UPLOAD || '/images/upload'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: bodyStr
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Upload failed: ${errText}`);
        }

        const saveResult = await resp.json();
        if (!saveResult?.path) throw new Error('No path returned from upload');

        return { success: true, localPath: saveResult.path, filename: `${filenameBase}.${extension}` };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}
