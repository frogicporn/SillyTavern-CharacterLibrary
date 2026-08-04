// Shared Saucepan API utilities - used by both saucepan-provider.js and
// saucepan-browse.js, plus DataCat for its Saucepan-sourced index rows
// (creator lookups, CDN images).
//
// All calls go through cl-helper (/plugins/cl-helper/saucepan-*), never ST's
// /proxy/: Saucepan responds with zstd-compressed bodies that ST's proxy
// forwards without a Content-Encoding header, leaving the browser unable to
// decode them. cl-helper negotiates gzip/br/deflate (falling back to native
// zstd) and performs the auth'd definition fetch + fragment reassembly.

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

const SAUCEPAN_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/saucepan-proxy`;

// Saucepan CDN images can't be hotlinked: the CDN answers with
// Cross-Origin-Resource-Policy: same-origin, so the browser refuses to render
// them from our origin. Route them through cl-helper's proxy instead. Images
// live at saucepan.ai/cdn/{imageId}/card; plugin routes are prefixed with /api.
export const SAUCEPAN_CDN_PROXY_BASE = `/api${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`;

/**
 * Canonical page URL for a companion.
 * @param {string} id - companion UUID
 * @returns {string}
 */
export function saucepanCompanionUrl(id) {
    return `https://saucepan.ai/companion/${id}`;
}

// order_by/asc pairs verified against Saucepan's own sort dropdown (web bundle).
const SAUCEPAN_ORDER_MAP = {
    saucepan_new: { order: 'created', asc: false },
    saucepan_oldest: { order: 'created', asc: true },
    saucepan_trending: { order: 'trending', asc: false },
    saucepan_popular: { order: 'popularity', asc: false },
    saucepan_updated: { order: 'updated', asc: false },
    saucepan_random: { order: 'random', asc: false },
};

// Saucepan's own default "content warning" exclusion list — the extreme-content
// tags the site hides by default (the "CW" toggle). Applied only when the user
// enables the "Hide extreme content" toggle; otherwise no tags are excluded.
const SAUCEPAN_CW_EXTREME_TAGS = [
    'noncon_dubcon', 'incest_stepcest', 'gore', 'body_horror', 'slur_usage',
    'self_harm_suicide', 'vore', 'cannibalism', 'feral', 'user_harm',
    'eating_disorder', 'amputation', 'miscarriage',
];

// ========================================
// NETWORK
// ========================================

let _apiRequest = null;
let _getSaucepanToken = null;

/**
 * Bind the CoreAPI.apiRequest function for proxied requests. Called from the
 * Saucepan provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter that returns the persisted Saucepan Bearer token (or null).
 * Used by native extraction to authenticate the definition fetch.
 */
export function setSaucepanTokenGetter(fn) { _getSaucepanToken = fn; }

/**
 * Return true if a Saucepan token appears to be configured.
 * @returns {boolean}
 */
export function hasSaucepanToken() { return !!(_getSaucepanToken?.() ?? null); }

/**
 * Ping cl-helper's health endpoint. Used by the auth bridges to report a
 * friendly "plugin not available" instead of a raw HTTP error.
 * @returns {Promise<boolean>}
 */
export async function checkClHelperAvailable() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

async function saucepanFetch(method, apiPath, body) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound (cl-helper required)');
    const url = `${SAUCEPAN_PROXY_BASE}${apiPath}`;
    return method === 'POST'
        ? _apiRequest(url, 'POST', body)
        : _apiRequest(url);
}

// ========================================
// SESSION (cl-helper token management)
// ========================================

/** Shared error shaping for the session endpoints. */
async function sessionError(resp) {
    const text = await resp.text().catch(() => '');
    return `HTTP ${resp.status}: ${text.slice(0, 200)}`;
}

/**
 * Log into Saucepan via cl-helper (which performs the credentialed request).
 * The password is never stored; the returned token is what callers persist.
 * @returns {Promise<{ok: boolean, token?: string, error?: string}>}
 */
export async function saucepanLogin(handle, password) {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-login`, 'POST', { handle, password });
        if (!resp.ok) return { ok: false, error: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Push a Bearer token into cl-helper's in-memory store (proxy auth).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function pushSaucepanToken(token) {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`, 'POST', { token });
        if (!resp.ok) return { ok: false, error: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Validate the token cl-helper currently holds.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateSaucepanSession() {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-validate`);
        if (!resp.ok) return { valid: false, reason: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

/**
 * Clear the token from cl-helper's in-memory store.
 * @returns {Promise<boolean>}
 */
export async function clearSaucepanToken() {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-clear-token`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
}

// ========================================
// IMAGES
// ========================================

/**
 * Rewrite a Saucepan CDN image URL to the local cl-helper proxy path.
 * Non-Saucepan URLs are returned unchanged.
 * @param {string} url
 * @returns {string}
 */
export function resolveSaucepanImageUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('https://saucepan.ai/cdn/')) {
        return url.replace('https://saucepan.ai/cdn/', SAUCEPAN_CDN_PROXY_BASE);
    }
    // Legacy CDN host found in older DataCat rows. The host no longer
    // resolves, but its path shape maps 1:1 onto saucepan.ai/cdn/.
    if (url.startsWith('https://cdn.saucepan.ai/images/')) {
        return url.replace('https://cdn.saucepan.ai/images/', SAUCEPAN_CDN_PROXY_BASE);
    }
    // Proxy paths from earlier builds that lack the /api prefix.
    if (url.startsWith(`${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`)) {
        return `/api${url}`;
    }
    return url;
}

// ========================================
// SEARCH / DETAIL
// ========================================

/**
 * Search Saucepan companions via the Saucepan API (proxied through cl-helper).
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=96]
 * @param {string} [opts.sort='saucepan_new'] - Key of SAUCEPAN_ORDER_MAP
 * @param {boolean} [opts.openDefinitionOnly=true]
 * @param {string[]} [opts.tags=[]] - Tag slugs to include
 * @param {boolean} [opts.matchAllTags=true] - Included tags: AND (true) or OR (false)
 * @param {string[]} [opts.excludedTags=[]] - Tag slugs to exclude
 * @param {string|null} [opts.postedAfter=null] - yyyy-MM-dd lower bound on posted_at
 * @returns {Promise<{characters: Object[], totalCount: number, totalPages: number}>}
 */
export async function searchSaucepan(opts = {}) {
    const {
        search = '',
        page = 1,
        limit = 96,
        sort = 'saucepan_new',
        openDefinitionOnly = true,
        tags = [],
        excludedTags = [],
        // SFW by default (user opts in via the browse toggle); maps to `sus`.
        nsfw = false,
        // Off by default: exclude nothing. When true, apply Saucepan's built-in
        // content-warning exclusion list on top of any user-excluded tags.
        hideExtreme = false,
        fandomTags = [],
        excludedFandomTags = [],
        matchAllFandomTags = false,
        // AND (true) vs OR (false) matching for included tags
        matchAllTags = true,
        // yyyy-MM-dd lower bound on posted_at, or null for any time
        postedAfter = null,
        // "Card must have" minimum counts (0 = don't filter)
        minPortraits = 0,
        minLorebooks = 0,
        minScenarios = 0,
        // true → exclude extra-spicy content (extra_spicy:false); false → no filter (extra_spicy:null)
        hideExtraSpicy = false,
    } = opts;
    const { order: orderBy, asc } = SAUCEPAN_ORDER_MAP[sort] || SAUCEPAN_ORDER_MAP.saucepan_new;
    const offset = Math.max(0, (page - 1) * limit);

    const baseExcluded = Array.isArray(excludedTags) ? excludedTags : [];
    const excluded = hideExtreme
        ? Array.from(new Set([...baseExcluded, ...SAUCEPAN_CW_EXTREME_TAGS]))
        : baseExcluded;

    const body = {
        text_search: search || null,
        tags: Array.isArray(tags) ? tags : [],
        excluded_tags: excluded,
        fandom_tags: Array.isArray(fandomTags) ? fandomTags : [],
        excluded_fandom_tags: Array.isArray(excludedFandomTags) ? excludedFandomTags : [],
        match_all_fandom_tags: !!matchAllFandomTags,
        limit,
        offset,
        sus: !!nsfw,
        extra_spicy: hideExtraSpicy ? false : null,
        order_by: orderBy,
        asc,
        posted_at_from: postedAfter || null,
        posted_at_to: null,
        match_all_tags: !!matchAllTags,
        min_portrait_count: minPortraits || 0,
        min_group_count: 0,
        min_lorebook_count: minLorebooks || 0,
        min_scenario_count: minScenarios || 0,
        hide_hidden_content: false,
        open_definition_only: openDefinitionOnly,
    };

    let response;
    try {
        response = await saucepanFetch('POST', '/api/v1/search', body);
    } catch (err) {
        throw new Error(`Saucepan search failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);

    const data = await response.json();
    const companions = data?.companions || [];
    const totalCount = data?.total_count || 0;
    const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 0;

    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount,
        totalPages,
    };
}

function normalizeSaucepanHit(hit) {
    const imageId = hit?.image?.id || '';
    const avatar = imageId ? `${SAUCEPAN_CDN_PROXY_BASE}${imageId}/card` : '';
    const tags = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        character_id: hit.id,
        name: hit.display_name || hit.name || 'Unknown',
        avatar,
        description: hit.short_description || '',
        tags,
        creator_name: hit.author_handle || '',
        creator_id: hit.author_id || '',
        createdAt: hit.posted_at || '',
        isNsfw: !!hit.sus,
        totalTokens: hit.card_token_count || 0,
        chat_count: hit.chat_count || 0,
        message_count: hit.interaction_count || 0,
        favorite_count: hit.favorite_count || 0,
        portrait_count: hit.portrait_count || 0,
        scenario_count: hit.scenario_count || 0,
        lorebook_count: hit.lorebook_count || 0,
        locked_starting_message: !!hit.locked_starting_message,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
    };
}

/**
 * Build a normalized hit from a companion-detail object (URL lookups, in-app
 * preview, the V2 builder). Mirrors the shape of normalizeSaucepanHit.
 * @param {Object|null} companion - Detail object from fetchSaucepanCompanion
 * @param {string} fallbackId - companion id to use when the detail is missing
 * @returns {Object}
 */
export function hitFromCompanion(companion, fallbackId) {
    const id = companion?.id || fallbackId;
    return {
        character_id: id,
        id,
        name: companion?.display_name || companion?.name || 'Unknown',
        display_name: companion?.display_name || companion?.name || 'Unknown',
        avatar: resolveSaucepanImageUrl(
            companion?.image?.highres_url
            || companion?.image?.url
            || (companion?.image?.id ? `https://saucepan.ai/cdn/${companion.image.id}/card` : ''),
        ),
        description: companion?.short_description || '',
        tags: Array.isArray(companion?.tags) ? companion.tags : [],
        creator_name: companion?.author_handle || '',
        creator_id: companion?.author_id || '',
        createdAt: companion?.posted_at || '',
        isNsfw: !!companion?.sus,
        totalTokens: companion?.card_token_count || 0,
        chat_count: companion?.chat_count || 0,
        message_count: companion?.interaction_count || 0,
        favorite_count: companion?.favorite_count || 0,
        portrait_count: Array.isArray(companion?.portraits) ? companion.portraits.length : 0,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
        _fullCompanion: companion,
    };
}

/**
 * Fetch all companions authored by a Saucepan handle.
 * The endpoint returns the full list in one response (no real pagination
 * support: limit/offset are ignored server-side, total_count == count).
 * @param {string} handle - Saucepan author handle
 * @returns {Promise<{characters: Object[], totalCount: number}>}
 */
export async function fetchSaucepanCompanionsOfUser(handle) {
    if (!handle) return { characters: [], totalCount: 0 };
    let response;
    try {
        response = await saucepanFetch('GET', `/api/v1/companions-of-user?handle=${encodeURIComponent(handle)}`);
    } catch (err) {
        throw new Error(`Saucepan creator fetch failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);
    const data = await response.json();
    const companions = data?.companions || [];
    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount: data?.total_count ?? companions.length,
    };
}

/**
 * Fetch a single Saucepan companion's detail by id.
 * Returns the raw `companion` object, or null on failure.
 * The detail endpoint exposes `open_definition` (boolean), which the
 * search/listing endpoint does not include.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
// Short-lived cache so the burst of companion reads when a card opens (preview
// header, link-modal stats, gallery) collapses to a single network round-trip.
// Stores the in-flight promise, so concurrent callers coalesce too.
const _saucepanCompanionCache = new Map(); // id -> { promise, ts }
const SAUCEPAN_COMPANION_TTL = 60_000;

export async function fetchSaucepanCompanion(id) {
    if (!id) return null;
    const cached = _saucepanCompanionCache.get(id);
    if (cached && (Date.now() - cached.ts) < SAUCEPAN_COMPANION_TTL) return cached.promise;
    // Companion detail lives at /api/v2/companions/<id> (Bearer-authed). The old
    // /api/v1/companion?id= form is a different endpoint and 405s on GET.
    const promise = (async () => {
        try {
            const response = await saucepanFetch('GET', `/api/v2/companions/${encodeURIComponent(id)}`);
            if (!response.ok) return null;
            const data = await response.json();
            return data?.companion || null;
        } catch {
            return null;
        }
    })();
    _saucepanCompanionCache.set(id, { promise, ts: Date.now() });
    // Don't cache misses: if it resolves null, drop it so the next call retries.
    promise.then(companion => { if (!companion) _saucepanCompanionCache.delete(id); });
    return promise;
}

/**
 * Fetch Saucepan's curated fandom (franchise/source-material) vocabulary.
 * Distinct from regular tags — passed to search as fandom_tags/excluded_fandom_tags.
 * @returns {Promise<Array<{id: string, name: string, description: string, searchTerms: string}>>}
 */
export async function fetchSaucepanFandoms() {
    try {
        const response = await saucepanFetch('GET', '/api/v1/fandoms');
        if (!response.ok) return [];
        const data = await response.json();
        const list = Array.isArray(data) ? data : (data?.fandoms || []);
        return list
            .filter(f => f && f.id && f.is_enabled !== false)
            .map(f => ({
                id: f.id,
                name: f.display_name || f.id,
                description: f.description || '',
                searchTerms: f.search_terms || '',
            }));
    } catch {
        return [];
    }
}

// ========================================
// LOREBOOKS
// ========================================

// A card can cite several lorebooks; V2 has one character_book, so they merge
// into a single book and each entry keeps its source in `comment`.
//
// Saucepan chapters carry no keyword field, and the books run large (a typical
// three-book card totals ~113k tokens), so importing them always-on would swamp
// every prompt. Keys are derived from the chapter title instead, plus the
// "-# Tags; a, b, c" line some creators write as an ad-hoc keyword list.
const SAUCEPAN_TAGS_LINE = /^\s*-#\s*Tags?\s*[;:]\s*(.+)$/im;

/**
 * Keyword list for a chapter. Title-derived, since Saucepan has no keys field.
 * @param {string} title
 * @param {string} text - raw chapter text (scanned for a "-# Tags;" line)
 * @returns {string[]}
 */
function saucepanChapterKeys(title, text) {
    const keys = new Set();
    // Titles are commonly numbered ("3. Skin, Fur & External Covering",
    // "5, 6, 10. Organ and Basic Bodily Operations."); the numbering is not a
    // useful trigger, and neither is a trailing period.
    const cleaned = String(title || '').replace(/^[\s\d.,)\-]+/, '').replace(/\.\s*$/, '').trim();
    if (cleaned) keys.add(cleaned);
    // A compound title is usually several distinct lookup terms. Splitting can
    // cut through a bracketed aside ("Skeletal System (Bones & Structure)"), so
    // drop the orphaned bracket rather than key on "Structure)".
    for (const part of cleaned.split(/\s*[&/,]\s*/)) {
        const p = part.replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
        if (p.length > 3) keys.add(p);
    }
    const tagLine = String(text || '').match(SAUCEPAN_TAGS_LINE);
    if (tagLine) {
        for (const t of tagLine[1].split(/[,;]/)) {
            const k = t.trim();
            if (k) keys.add(k);
        }
    }
    return [...keys].slice(0, 32);
}

/**
 * Strip Saucepan's display-only markup from chapter text.
 * `<notcontext>` flags a line Saucepan itself keeps out of the prompt (headings,
 * attribution, rules) — dropping those lines matches what the card actually runs.
 * @param {string} text
 * @returns {string}
 */
function saucepanChapterText(text) {
    return String(text || '')
        .split('\n')
        .filter(line => !line.includes('<notcontext>'))
        .join('\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .trim();
}

/**
 * Fetch a companion's readable lorebooks and merge them into one V2 character_book.
 * Books the creator gated are skipped rather than imported as empty shells.
 * @param {string} companionId - companion UUID
 * @returns {Promise<Object|null>} V2 character_book, or null if none readable
 */
export async function fetchSaucepanLorebook(companionId) {
    if (!companionId) return null;

    let books;
    try {
        const resp = await saucepanFetch('GET', `/api/v1/companions/${encodeURIComponent(companionId)}/lorebooks`);
        if (!resp.ok) return null;
        books = (await resp.json())?.lorebooks;
    } catch {
        return null;
    }
    if (!Array.isArray(books) || books.length === 0) return null;

    const entries = [];
    const names = [];
    let skipped = 0;
    let unkeyable = 0;

    for (const book of books) {
        if (!book?.id) continue;
        // Lorebooks carry their own lock, same shape as a definition's.
        if (book.definition_protection && book.definition_protection !== 'open') {
            skipped++;
            continue;
        }
        let data;
        try {
            const resp = await saucepanFetch('GET', `/api/v1/lorebooks/${encodeURIComponent(book.id)}`);
            if (!resp.ok) { skipped++; continue; }
            data = await resp.json();
        } catch {
            skipped++;
            continue;
        }
        // can_read is the server's own verdict; trust it over the listing flag.
        if (data?.can_read && data.can_read !== 'open') {
            skipped++;
            continue;
        }

        const bookName = data?.name || book.name || 'Saucepan lorebook';
        const chapters = Array.isArray(data?.content) ? data.content : [];
        let added = 0;
        for (const chapter of chapters) {
            const content = saucepanChapterText(chapter?.text);
            if (!content) continue;
            const title = String(chapter?.title || '').trim();
            const keys = saucepanChapterKeys(title, chapter?.text);
            // Purely numbered titles ("10.") leave nothing to trigger on. A
            // keyless non-constant entry can never fire, so it would only pad
            // the card; skip it rather than ship dead weight.
            if (keys.length === 0) {
                unkeyable++;
                continue;
            }
            entries.push({
                keys,
                content,
                extensions: {},
                enabled: true,
                insertion_order: entries.length,
                case_sensitive: false,
                name: title,
                comment: title ? `${bookName} — ${title}` : bookName,
                selective: false,
                secondary_keys: [],
                constant: false,
                position: 'before_char',
            });
            added++;
        }
        if (added > 0) names.push(bookName);
    }

    if (entries.length === 0) return null;
    if (skipped > 0) {
        console.warn(`[Saucepan] Skipped ${skipped} unreadable lorebook(s) for companion ${companionId}`);
    }
    if (unkeyable > 0) {
        console.warn(`[Saucepan] Skipped ${unkeyable} lorebook chapter(s) with no derivable keyword for companion ${companionId}`);
    }

    return {
        name: names.join(' + ').slice(0, 200),
        description: `Imported from Saucepan (${names.length} lorebook${names.length === 1 ? '' : 's'}, ${entries.length} entries)`,
        scan_depth: 4,
        token_budget: 2048,
        recursive_scanning: false,
        extensions: {},
        entries,
    };
}

/**
 * Attach a companion's lorebooks to a freshly built V2 card, in place.
 *
 * Every path that builds a Saucepan card goes through here — import, preview and
 * the update-check fetch alike. They must agree: card-updates always diffs
 * character_book, so a path that skipped this would report an imported lorebook
 * as remotely deleted on the next check.
 *
 * @param {Object|null} card - V2 card from buildV2FromSaucepan (null passes through)
 * @param {string} companionId
 * @returns {Promise<Object|null>} the same card
 */
export async function attachSaucepanLorebook(card, companionId) {
    if (!card?.data || !companionId) return card;
    // Entirely optional: a card with no books, or only gated ones, still imports.
    const book = await fetchSaucepanLorebook(companionId);
    if (book) card.data.character_book = book;
    return card;
}

// ========================================
// NATIVE EXTRACTION
// ========================================

/**
 * Submit a Saucepan companion URL for native extraction via cl-helper.
 * Requires a Saucepan Bearer token (login or manually pasted).
 * @param {string} companionUrl - Full Saucepan companion URL
 * @returns {Promise<{success: boolean, assembled?: Object, greetings?: Object[], error?: string}>}
 */
export async function submitSaucepanExtraction(companionUrl) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound');
    // Send the persisted token when we have one; cl-helper falls back to its
    // own stored token (e.g. from a login this session) and 401s if neither
    // side has one.
    const token = _getSaucepanToken?.() ?? null;
    try {
        const resp = await _apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-extract`,
            'POST',
            token ? { url: companionUrl, token } : { url: companionUrl },
        );
        if (!resp.ok) {
            const errText = await resp.text();
            console.error(
                '[Saucepan] saucepan-extract error:',
                resp.status,
                errText.substring(0, 200),
            );
            return {
                success: false,
                error: `Server returned ${resp.status}: ${errText.substring(0, 100)}`,
            };
        }
        const data = await resp.json();
        if (data?.error) {
            return { success: false, error: data.error };
        }
        return {
            success: true,
            assembled: data.assembled,
            greetings: data.greetings,
        };
    } catch (e) {
        console.error('[Saucepan] submitSaucepanExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Build a V2 character card from native Saucepan extraction data.
 * Returns null when the definition carries no usable body so callers can
 * fall back to DataCat's aggregated copy instead of importing an empty card.
 *
 * Section/greeting -> V2 field mapping:
 *   'Companion Core'                  -> description (character body)
 *   'Example Dialogue'                -> mes_example
 *   'Advanced Prompt'                 -> system_prompt
 *   'Response Formatting Instructions'-> post_history_instructions
 *   greetings[0]                      -> first_mes
 *   greetings[1..]                    -> alternate_greetings
 * @param {Object} hit - Normalized Saucepan hit from search/companions endpoint
 * @param {Object} extractData - Response from /saucepan-extract { assembled: {...}, greetings: [{title, text}] }
 * @returns {Object|null}
 */
export function buildV2FromSaucepan(hit, extractData) {
    const assembled = extractData?.assembled;
    if (!hit || !assembled) return null;
    const description = assembled['Companion Core'] || '';
    if (!description) {
        console.warn(
            '[Saucepan] Companion Core section not found in Saucepan extraction. Available sections:',
            Object.keys(assembled).join(', ') || '(none)',
        );
        return null;
    }
    const mesExample = assembled['Example Dialogue'] || '';
    const systemPrompt = assembled['Advanced Prompt'] || '';
    const postHistory = assembled['Response Formatting Instructions'] || '';

    // Starting scenarios become greetings: the first is first_mes, the rest
    // are alternate greetings. cl-helper already assembled and filtered them.
    const greetingTexts = Array.isArray(extractData.greetings)
        ? extractData.greetings.map(g => g?.text || '').filter(Boolean)
        : [];
    const firstMes = greetingTexts[0] || '';
    const alternateGreetings = greetingTexts.slice(1);

    const tagNames = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: hit.display_name || hit.name || 'Unknown',
            description,
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: mesExample,
            system_prompt: systemPrompt,
            post_history_instructions: postHistory,
            creator_notes: hit.description || '',
            creator: hit.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: alternateGreetings,
            extensions: {
                saucepan: {
                    id: hit.character_id || hit.id,
                    creatorId: hit.creator_id || null,
                    creatorName: hit.creator_name || null,
                },
            },
        },
    };
}

/**
 * Build a DataCat-compatible character object from a Saucepan hit + native extraction.
 * This lets the browse preview modal render native-extracted Saucepan cards the same
 * way it renders DataCat-aggregated ones.
 * @param {Object} hit - Normalized Saucepan hit
 * @param {Object} v2Card - V2 card from buildV2FromSaucepan
 * @returns {Object}
 */
export function buildSaucepanCharacterFromHit(hit, v2Card) {
    const description = v2Card?.data?.description || '';
    return {
        character_id: hit.character_id || hit.id,
        name: hit.display_name || hit.name || 'Unknown',
        avatar: hit.avatar || '',
        description,
        short_description: hit.description || '',
        tags: hit.tags || [],
        creator_name: hit.creator_name || '',
        creator_id: hit.creator_id || '',
        primary_content_source_kind: 'saucepan',
        companion_snapshot: {
            full_description: hit.description || '',
        },
        chara_card_v2_json: v2Card,
        chat_count: hit.chat_count || 0,
        message_count: hit.message_count || 0,
        totalTokens: hit.totalTokens || 0,
        _source: 'saucepan',
    };
}

/**
 * Fetch a Saucepan companion's full definition and build a V2 card.
 * @param {Object} hit - Normalized Saucepan hit (must have character_id or id)
 * @returns {Promise<Object|null>} V2 card or null
 */
export async function fetchSaucepanV2Card(hit) {
    if (!hit?.character_id && !hit?.id) return null;
    const id = hit.character_id || hit.id;
    const result = await submitSaucepanExtraction(saucepanCompanionUrl(id));
    if (!result.success) {
        console.warn('[Saucepan] Native extraction failed:', result.error);
        return null;
    }
    return attachSaucepanLorebook(buildV2FromSaucepan(hit, result), id);
}
