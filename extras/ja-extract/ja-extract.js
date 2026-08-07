#!/usr/bin/env node
// ja-extract -- batch-extract JanitorAI character definitions to V2 character cards.
//
// A definition its creator has withheld is still sent to the model at chat time, so proxy mode is
// the surface it can be read from: JanitorAI assembles the whole prompt (system = definition,
// assistant = the opening line) and hands it to the client to forward to the user's own endpoint.
// Point that endpoint at a dead port and the assembled prompt is the response.
//
// The account mutation that enables this is global, not per character, so it is done once for the
// whole run and undone at the end -- which is the entire reason a batch tool is worth having over
// looping the single-card path.
//
// Needs a bearer token and nothing else: no browser, no SillyTavern, no cl-helper. JanitorAI's edge
// rejects a plain node fetch on its TLS fingerprint alone, so requests go through impit, which
// presents a real Firefox handshake.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'https://janitorai.com';
const AUTH_BASE = 'https://mcmzxtzommpnxkynddbo.supabase.co/auth/v1';
// JanitorAI's public publishable key; it ships in their own client code.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 1000;
const RATE_LIMIT_MAX_WAIT_MS = 15000;

const HELP = `
ja-extract -- batch-extract JanitorAI definitions to V2 character cards

  ja-extract [options] <id-or-url>...

Characters
  <id-or-url>          character uuid, or any janitorai.com URL containing one
  -f, --file <path>    read ids/urls from a file, one per line (# comments ok)

Auth (one of these; JanitorAI login itself is captcha-gated, so bring a session)
  -t, --token <jwt>    access token          (env JA_TOKEN)
  -s, --session <raw>  sb-auth-auth-token cookie value, base64- form included
                                             (env JA_SESSION)
      --session-file <path>  read that cookie value from a file

Output
  -o, --out <dir>      write cards here (default ./cards)
      --raw            also write the untouched JanitorAI detail json

Tuning
  -c, --concurrency N  characters in flight (default 4)
      --keep-settings  leave the account in proxy mode instead of restoring it.
                       Only for a dedicated extraction account: normal chatting
                       stays broken until you restore it yourself.
  -h, --help           this text

Extracting a definition briefly switches the account to proxy mode with an
unbounded context, and switches it back at the end. Do not chat on the account
while a run is in progress.
`;

// =============================================================================
// Transport
// =============================================================================

let _impit = null;

async function impit() {
    if (_impit) return _impit;
    const { Impit } = await import('impit');
    // chrome* impersonation is refused by the edge; firefox passes.
    _impit = new Impit({ browser: 'firefox133' });
    return _impit;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One JanitorAI API call. Returns { status, data, text }. */
async function ja(method, path, body, token, { accept } = {}) {
    const headers = {
        accept: accept || 'application/json, text/plain, */*',
        'user-agent': UA,
        referer: `${ORIGIN}/`,
        'x-app-version': '9.9.999',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const init = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };

    const client = await impit();
    let resp = await client.fetch(`${ORIGIN}${path}`, init);
    // A 429 means the request was never processed, so replaying it is safe even for a POST.
    for (let attempt = 0; resp.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
        const after = Number(resp.headers?.get?.('retry-after'));
        const wait = Number.isFinite(after) && after > 0
            ? Math.min(after * 1000, RATE_LIMIT_MAX_WAIT_MS)
            : RATE_LIMIT_BASE_MS * (2 ** attempt);
        warn(`rate limited on ${path}; retrying in ${wait}ms`);
        await sleep(wait);
        resp = await client.fetch(`${ORIGIN}${path}`, init);
    }
    if (resp.status === 403) {
        throw new Error('JanitorAI refused the request outright (403). Its edge may have stopped accepting this TLS fingerprint; try a newer impit.');
    }
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: resp.status, data, text: data ? null : text };
}

// =============================================================================
// Session
// =============================================================================

function b64decode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Buffer.from(t, 'base64').toString('utf8');
}

/** Pull { access_token, refresh_token } out of a raw sb-auth-auth-token cookie value. */
function parseSession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = decodeURIComponent(raw.trim());
    if (s.startsWith('base64-')) s = s.slice('base64-'.length);
    let json = null;
    try {
        const dec = b64decode(s);
        if (dec.includes('access_token')) json = JSON.parse(dec);
    } catch {}
    if (!json && s.startsWith('{')) {
        try { json = JSON.parse(s); } catch {}
    }
    if (json?.access_token) return { access_token: json.access_token, refresh_token: json.refresh_token || '' };
    // Last resort: a bare JWT pasted instead of the cookie.
    const m = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return m ? { access_token: m[0], refresh_token: '' } : null;
}

function jwtExpiryMs(jwt) {
    try {
        return (JSON.parse(b64decode(String(jwt).split('.')[1])).exp || 0) * 1000;
    } catch { return 0; }
}

/** Trade a refresh token for a fresh access token. Not captcha-gated, unlike password login. */
async function refreshGrant(refreshToken) {
    const resp = await fetch(`${AUTH_BASE}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
        throw new Error(`Could not refresh the session (HTTP ${resp.status}). Paste a current sb-auth-auth-token cookie.`);
    }
    return data.access_token;
}

async function resolveToken(opts) {
    if (opts.token) return opts.token;
    let raw = opts.session;
    if (opts.sessionFile) raw = (await readFile(opts.sessionFile, 'utf-8')).trim();
    if (!raw) {
        throw new Error('No session. Pass --token, --session, or --session-file (see --help).');
    }
    const pair = parseSession(raw);
    if (!pair?.access_token) throw new Error('That session value did not contain an access token.');
    // Two minutes of headroom: a token that expires mid-run fails every remaining character.
    const exp = jwtExpiryMs(pair.access_token);
    if (exp && exp - Date.now() < 120000) {
        if (!pair.refresh_token) throw new Error('That session has expired and carries no refresh token.');
        log('session expired; refreshing');
        return refreshGrant(pair.refresh_token);
    }
    return pair.access_token;
}

// =============================================================================
// The extraction window (account-global, opened once per run)
// =============================================================================

const SELECTED_PRESET_KEYS = ['selected_proxy_config_id', 'selected_proxy_id'];

/** Detected per response, never assumed: patching a key this deployment does not use would leave
 *  the selection pointing at the preset we then delete. */
function resolveSelectedPresetKey(data) {
    for (const scope of [data?.settings, data?.legacy_config, data]) {
        if (!scope || typeof scope !== 'object') continue;
        for (const key of SELECTED_PRESET_KEYS) {
            if (key in scope) return { key, value: scope[key] ?? null };
        }
    }
    return { key: null, value: null };
}

function randomHex(bytes) {
    let out = '';
    while (out.length < bytes * 2) out += randomUUID().replace(/-/g, '');
    return out.slice(0, bytes * 2);
}

/**
 * The pristine settings are written to disk before the first mutation and removed only once they
 * are back on the account. Nothing else can tell a crashed run's leftovers apart from a choice the
 * user made, and guessing wrong makes the sentinel settings permanent.
 *
 * Deliberately the same path and shape cl-helper uses: the two tools mutate the same settings the
 * same way, so either can heal an account the other crashed on.
 */
const RESTORE_FILE = join(tmpdir(), 'cl-janitorai-restore.json');

async function rememberPristine(state) {
    try { await writeFile(RESTORE_FILE, JSON.stringify(state), 'utf-8'); } catch {}
}

async function recallPristine() {
    try { return JSON.parse(await readFile(RESTORE_FILE, 'utf-8')); } catch { return null; }
}

async function openWindow(token) {
    const snap = await ja('GET', '/hampter/api-settings', null, token);
    if (snap.status === 401) throw new Error('JanitorAI rejected the session (401). It has expired or been revoked.');
    const prev = snap.data?.legacy_config || snap.data?.settings || {};
    const selected = resolveSelectedPresetKey(snap.data);
    let pristine = {
        source: prev.api || prev.source || 'janitor',
        selectedKey: selected.key,
        selectedValue: selected.value,
        generation: prev.generation_settings && typeof prev.generation_settings === 'object' ? prev.generation_settings : null,
    };
    // 0 is the sentinel this tool sets and no usable value for chatting, so finding it live means a
    // previous run never restored. Treating it as the account's own setting would make it permanent.
    if (pristine.generation?.context_length === 0) {
        const saved = await recallPristine();
        if (!saved?.generation?.context_length) {
            throw new Error('This account is still in extraction mode from an earlier run (context length 0), and the saved copy of your settings is gone. Set your context length back in JanitorAI settings first, or the old value will be lost.');
        }
        warn('the account was left in extraction mode by an earlier run; restoring the saved copy.');
        // The crashed run's decoy preset outlives it and nothing else will ever reference it, so it
        // would sit in the account's preset list forever, one per crash.
        if (saved.proxyId) await ja('DELETE', `/hampter/api-settings/proxy-configs/${saved.proxyId}`, null, token).catch(() => {});
        pristine = { ...saved, proxyId: null };
    }
    // Never override a context length we cannot put back; the account would inherit it in chats.
    if (typeof pristine.generation?.context_length !== 'number') {
        throw new Error('Could not read the account generation settings, so nothing was changed.');
    }
    await rememberPristine(pristine);

    // Ephemeral range: nothing listens there by convention, so this cannot reach a local model
    // server running on a well-known port.
    const deadPort = 49152 + Math.floor(Math.random() * 16384);
    const created = await ja('POST', '/hampter/api-settings/proxy-configs', {
        client_id: randomUUID(),          // rejected server-side once used, so not a constant
        name: randomHex(8),
        model: 'gpt-4-turbo',
        api_url: `http://127.0.0.1:${deadPort}/v1/chat/completions`,
        api_key: `sk-${randomHex(20)}`,   // only has to be non-blank; nothing ever arrives
        prompt_id: null,
    }, token);
    const cfgs = created.data?.proxy_configs || [];
    const proxyId = cfgs.length ? cfgs[cfgs.length - 1].id : null;
    if (!proxyId) throw new Error(`JanitorAI rejected the temporary proxy preset (HTTP ${created.status})`);
    // Re-written now that the decoy exists so a crash from here on leaves something able to clean it
    // up. The settings had to be saved before this point, hence the second write rather than one.
    await rememberPristine({ ...pristine, proxyId });

    const win = { token, proxyId, pristine, liveConfig: null };
    try {
        await ja('PATCH', '/hampter/api-settings', {
            source: 'proxy',
            [pristine.selectedKey || SELECTED_PRESET_KEYS[0]]: proxyId,
            // A bounded context makes the server rewrite the prompt, destroying the section
            // boundaries the definition is read back from.
            generation_settings: { context_length: 0 },
        }, token);

        // Read the account back rather than hand-building userConfig for generateAlpha: the server
        // validates it as a whole, so a plausible-looking config assembled here is a 500, not a set
        // of defaults. Also self-correcting, since it carries whatever fields JanitorAI adds later.
        const live = await ja('GET', '/hampter/api-settings', null, token);
        win.liveConfig = live.data?.legacy_config || live.data?.settings || null;
        if (!win.liveConfig || typeof win.liveConfig !== 'object') {
            throw new Error(`Could not read back the temporary settings (HTTP ${live.status})`);
        }
    } catch (e) {
        await closeWindow(win);
        throw e;
    }
    return win;
}

async function closeWindow(win) {
    if (!win) return;
    const { token, proxyId, pristine } = win;
    // DELETE must carry no body: an empty body with a json content-type 400s.
    if (proxyId) await ja('DELETE', `/hampter/api-settings/proxy-configs/${proxyId}`, null, token).catch(() => {});
    const restored = await ja('PATCH', '/hampter/api-settings', {
        source: pristine.source,
        // Null is meaningful here (nothing was selected), so send it whenever the key was found.
        ...(pristine.selectedKey ? { [pristine.selectedKey]: pristine.selectedValue } : {}),
        // Replayed wholesale; rebuilding it would swap tuning values we do not model for defaults.
        ...(pristine.generation ? { generation_settings: pristine.generation } : {}),
    }, token).catch(() => null);
    // Only drop the saved copy once the account actually has it back; otherwise the next run has
    // nothing to heal from.
    if (restored && restored.status < 400) {
        try { await unlink(RESTORE_FILE); } catch {}
    } else {
        warn('could not restore the account settings. Check your JanitorAI settings: context length and API source may still be in extraction mode.');
        warn(`your settings were: source=${pristine.source} generation_settings=${JSON.stringify(pristine.generation)}`);
        warn(`a copy is saved at ${RESTORE_FILE}; the next run will use it to put them back.`);
    }
}

// =============================================================================
// Per-character extraction
// =============================================================================

/** JanitorAI bakes macros into the prompt before sending, so the captured text has real names
 *  where {{user}}/{{char}} were. The sentinel is recoverable exactly because we chose it. */
function restoreMacros(text, sentinel, detail) {
    let out = String(text || '');
    const swap = (needle, macro) => {
        const n = String(needle || '').trim();
        // A one or two character name (a bare space is a real name on JanitorAI) would match
        // everywhere and shred the text.
        if (n.length < 3) return;
        out = out.split(n).join(macro);
    };
    swap(sentinel, '{{user}}');
    swap(detail?.chat_name, '{{char}}');
    if (detail?.name !== detail?.chat_name) swap(detail?.name, '{{char}}');
    return out;
}

function hasHiddenDefinition(detail) {
    return !detail?.personality;
}

async function extractOne(win, detail) {
    const { token, liveConfig } = win;
    // No fixed affix, so a persona left behind by a failed run reads as noise, not a marker.
    const sentinel = randomHex(12).toUpperCase();
    let personaId = null;
    let chatId = null;
    try {
        const persona = await ja('POST', '/hampter/personas', {
            appearance: '', avatar: '', groupId: null, name: sentinel, pronouns: null,
        }, token);
        personaId = persona.data?.id || null;

        const chat = await ja('POST', '/hampter/chats',
            personaId ? { character_id: detail.id, persona_id: personaId } : { character_id: detail.id }, token);
        chatId = chat.data?.id;
        if (!chatId) throw new Error(`Could not open a chat with this character (HTTP ${chat.status})`);

        // The prompt is only assembled once the chat has a user turn, so "hi" still has to be sent
        // -- but as the API call the composer would have made, not by driving the page.
        const sent = await ja('POST', `/hampter/chats/${chatId}/messages`, {
            is_bot: false, is_main: true, message: 'hi',
            metadata: { persona_id: personaId || null },
            character_id: detail.id, chat_id: chatId,
        }, token);
        if (sent.status >= 400) throw new Error(`Could not send the priming message (HTTP ${sent.status})`);

        // Read the state back rather than assembling it: JanitorAI stamps ids and timestamps on
        // both turns and generateAlpha echoes them verbatim. Note the per-chat messages route is a
        // 404; the chat itself carries them.
        const state = await ja('GET', `/hampter/chats/${chatId}`, null, token);
        if (!state.data?.chat || !Array.isArray(state.data?.chatMessages)) {
            throw new Error(`Could not read the chat back (HTTP ${state.status})`);
        }

        const gen = await ja('POST', '/generateAlpha', {
            chat: state.data.chat,
            chatMessages: state.data.chatMessages,
            clientPlatform: 'web',
            forcedPromptGenerationCacheRefetch: { character: false, chat: false, profile: true, script: false },
            generateMode: 'NEW',
            generateType: 'CHAT',
            // Named with the sentinel rather than the real profile: whichever of these the server
            // substitutes from, the sentinel is what comes back, which is what restoreMacros needs.
            profile: { id: state.data.chat.user_id, name: sentinel, user_name: sentinel },
            profiles: [{ id: state.data.chat.user_id, name: sentinel, type: 'profile', user_name: sentinel }],
            // Streaming off: we want the assembled prompt as one body, not an SSE trickle.
            userConfig: { ...liveConfig, text_streaming: false },
        }, token, { accept: 'text/event-stream' });

        const body = gen.data ? JSON.stringify(gen.data) : (gen.text || '');
        if (!body) throw new Error('JanitorAI never assembled the prompt. It may be rate limiting; try again shortly.');

        // The payload is the whole chat request:
        //   system    = the definition
        //   assistant = the character's opening line, ie. the first message
        // A withheld definition withholds first_message from the API too, so the assistant turn is
        // the only place the opening line can be recovered from.
        let system = '';
        let firstMessage = '';
        try {
            const msgs = JSON.parse(body).messages || [];
            system = msgs.find(m => m.role === 'system')?.content || '';
            firstMessage = msgs.find(m => m.role === 'assistant')?.content || '';
        } catch {
            // Proxy mode is the only mode that hands the assembled prompt back, so a creator who
            // forbids it has closed the sole surface the definition can be read from.
            if (/proxies are forbidden/i.test(body)) {
                throw new Error('The creator has turned off proxy access for this character, so its definition cannot be recovered.');
            }
            throw new Error(`JanitorAI did not return a prompt: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'the response was empty'}`);
        }
        if (!system) throw new Error('Captured prompt carried no system message.');
        return {
            definition: restoreMacros(system, sentinel, detail),
            firstMessage: firstMessage ? restoreMacros(firstMessage, sentinel, detail) : '',
        };
    } finally {
        // The chat exists only so JanitorAI will assemble the prompt; it is a side effect of the
        // capture, not a result. Removed before the persona it references. Best effort, and
        // deliberately not aborting each other.
        if (chatId) await ja('DELETE', `/hampter/chats/${chatId}`, null, token).catch(() => {});
        if (personaId) await ja('DELETE', `/hampter/personas/${personaId}`, null, token).catch(() => {});
    }
}

// =============================================================================
// Card building
// =============================================================================

function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

const TAGLINE_MAX = 200;

/** First sentence of the blurb, or a word-boundary truncation when that is still too long. */
function taglineExcerpt(html) {
    const text = decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const firstSentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] || text;
    const base = firstSentence.length <= TAGLINE_MAX ? firstSentence : text;
    if (base.length <= TAGLINE_MAX) return base;
    const cut = base.slice(0, TAGLINE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > TAGLINE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

const SCRIPT_PATH_RE = /^\/hampter\/script\/[0-9a-f-]{36}$/i;

/** Lorebooks arrive on the detail as stubs; the content sits behind a per-script fetch. Mutates
 *  `detail.scripts` in place, best effort -- one locked lorebook must not fail the whole card. */
async function hydrateScripts(detail, token) {
    const scripts = detail?.scripts;
    if (!Array.isArray(scripts)) return;
    for (const s of scripts) {
        if (!s || s.type !== 'lorebook' || !s.is_public || s.script) continue;
        // Listed publicly but the creator locked the content; hampter serves metadata only.
        if (s.is_code_public === false) continue;
        let path = null;
        if (typeof s.api_path === 'string' && SCRIPT_PATH_RE.test(s.api_path)) path = s.api_path;
        else if (typeof s.id === 'string' && UUID_RE.test(s.id)) path = `/hampter/script/${s.id}`;
        if (!path) continue;
        try {
            const full = await ja('GET', path, null, token);
            if (typeof full.data?.script === 'string' && full.data.script) {
                s.script = full.data.script;
                if (!s.settings && typeof full.data.settings === 'string') s.settings = full.data.settings;
            }
        } catch { /* leave unfetched */ }
    }
}

/** Requires content: run hydrateScripts first, or a stub-only card yields null. */
function extractCharacterBook(detail) {
    const usable = (detail?.scripts || []).filter(s => s && s.type === 'lorebook' && s.is_public && s.script);
    if (!usable.length) return null;

    const entries = [];
    for (const s of usable) {
        let parsed;
        try { parsed = JSON.parse(s.script); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        for (const e of parsed) {
            if (!e || typeof e !== 'object') continue;
            entries.push({
                keys: Array.isArray(e.key) ? e.key : (e.keysRaw ? String(e.keysRaw).split(/,\s*/).filter(Boolean) : []),
                secondary_keys: [],
                content: e.content || '',
                extensions: {},
                enabled: e.enabled !== false,
                insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : (e.priority || 100),
                case_sensitive: false,
                name: e.name || '',
                priority: typeof e.priority === 'number' ? e.priority : 10,
                id: e.id ?? entries.length,
                comment: '',
                selective: false,
                constant: e.constant === true,
                position: 'before_char',
            });
        }
    }
    if (!entries.length) return null;

    const first = usable[0];
    let scanDepth = 4;
    try {
        const settings = first.settings ? JSON.parse(first.settings) : null;
        if (settings && typeof settings.depth === 'number') scanDepth = settings.depth;
    } catch { /* default */ }

    return {
        name: first.title || 'Lorebook',
        description: first.description || '',
        scan_depth: scanDepth,
        token_budget: 0,
        recursive_scanning: false,
        extensions: {},
        entries,
    };
}

function buildV2(detail, { definition = '', firstMessage = '' } = {}) {
    const tags = [
        ...(detail.tags || []),
        ...(detail.custom_tags || []),
    ].map(t => decodeEntities(typeof t === 'string' ? t : t?.name || '')).filter(Boolean);

    // Padded with nulls and invisible-character placeholders that would import as blank greetings.
    const altGreetings = (detail.first_messages || [])
        .map(g => (typeof g === 'string' ? g : g?.first_message || g?.message || ''))
        .filter(g => g && /[\p{L}\p{N}]/u.test(g));

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: decodeEntities(detail.chat_name || detail.name || 'Unknown'),
            description: definition || detail.personality || '',
            personality: '',
            scenario: detail.scenario || '',
            first_mes: detail.first_message || firstMessage || '',
            mes_example: detail.example_dialogs || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: decodeEntities(detail.description || ''),
            creator: decodeEntities(detail.creator_name || ''),
            character_version: '1.0',
            tags,
            alternate_greetings: altGreetings,
            extensions: {
                janitorai: {
                    id: detail.id,
                    creatorId: detail.creator_id || null,
                    creatorName: decodeEntities(detail.creator_name || '') || null,
                    tagline: taglineExcerpt(detail.description) || null,
                    definitionHidden: hasHiddenDefinition(detail) || undefined,
                    extracted: definition ? true : undefined,
                },
            },
            character_book: extractCharacterBook(detail) || undefined,
        },
    };
}

function slugify(name, id) {
    const base = String(name || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
    // The id keeps two characters of the same name from overwriting each other.
    return `${base || 'character'}-${String(id).slice(0, 8)}`;
}

// =============================================================================
// CLI
// =============================================================================

const log = (...a) => console.log('[ja-extract]', ...a);
const warn = (...a) => console.warn('[ja-extract]', ...a);

function parseArgs(argv) {
    const opts = { ids: [], out: 'cards', concurrency: 4 };
    const need = (i, flag) => {
        if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '-h': case '--help': opts.help = true; break;
            case '-t': case '--token': opts.token = need(i, a); i++; break;
            case '-s': case '--session': opts.session = need(i, a); i++; break;
            case '--session-file': opts.sessionFile = need(i, a); i++; break;
            case '-f': case '--file': opts.file = need(i, a); i++; break;
            case '-o': case '--out': opts.out = need(i, a); i++; break;
            case '-c': case '--concurrency': opts.concurrency = Number(need(i, a)); i++; break;
            case '--raw': opts.raw = true; break;
            case '--keep-settings': opts.keepSettings = true; break;
            default:
                if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
                opts.ids.push(a);
        }
    }
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
        throw new Error('--concurrency must be a positive integer');
    }
    return opts;
}

/** Accepts a bare uuid or any janitorai URL containing one. */
function toCharacterId(input) {
    const s = String(input).trim();
    if (UUID_RE.test(s)) return s;
    const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
}

async function collectIds(opts) {
    const raw = [...opts.ids];
    if (opts.file) {
        const text = await readFile(opts.file, 'utf-8');
        for (const line of text.split(/\r?\n/)) {
            const t = line.trim();
            if (t && !t.startsWith('#')) raw.push(t);
        }
    }
    const ids = [];
    for (const r of raw) {
        const id = toCharacterId(r);
        if (!id) warn(`skipping "${r}": no character id in it`);
        else if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** Run `worker` over `items`, `limit` at a time. Rejections are captured, never thrown: one bad
 *  character must not abandon the rest of the batch with the account still mutated. */
async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = { ok: true, value: await worker(items[i], i) };
            } catch (e) {
                results[i] = { ok: false, error: e };
            }
        }
    });
    await Promise.all(runners);
    return results;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return 0; }

    opts.token ||= process.env.JA_TOKEN || '';
    opts.session ||= process.env.JA_SESSION || '';

    const ids = await collectIds(opts);
    if (!ids.length) { console.log(HELP); return 1; }

    const token = await resolveToken(opts);
    await mkdir(opts.out, { recursive: true });

    // Fetched before the account is touched: a batch that is entirely public characters never needs
    // proxy mode at all, and a bad id should fail before anything is mutated.
    log(`fetching ${ids.length} character${ids.length === 1 ? '' : 's'}`);
    const details = await pool(ids, opts.concurrency, async (id) => {
        const r = await ja('GET', `/hampter/characters/${id}`, null, token);
        if (r.status === 404) throw new Error('no longer exists on JanitorAI');
        if (r.status >= 400 || !r.data) throw new Error(`HTTP ${r.status}`);
        return r.data;
    });

    const found = [];
    let failed = 0;
    details.forEach((r, i) => {
        if (r.ok) found.push(r.value);
        else { failed++; warn(`${ids[i]}: ${r.error.message}`); }
    });

    const hidden = found.filter(hasHiddenDefinition);
    log(`${found.length} fetched, ${hidden.length} with hidden definitions`);

    const extracted = new Map();
    let win = null;
    if (hidden.length) {
        // One window for the whole batch. This is the point of the tool: the setup/restore dance is
        // account-global, so paying it once instead of per character is most of the speedup, and
        // holding it open is what makes fanning out safe rather than corrupting.
        win = await openWindow(token);
        // A run killed here leaves the account in proxy mode, so make ctrl-c put it back -- unless
        // the caller asked for it to stay, in which case restoring on the way out would be the one
        // thing they said not to do.
        const onSignal = () => {
            if (opts.keepSettings) {
                warn('--keep-settings: interrupted with the account still in proxy mode.');
                process.exit(130);
            }
            closeWindow(win).finally(() => process.exit(130));
        };
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        try {
            const started = Date.now();
            const results = await pool(hidden, opts.concurrency, async (detail) => {
                const rec = await extractOne(win, detail);
                log(`extracted ${detail.chat_name || detail.name} (${rec.definition.length} chars)`);
                return rec;
            });
            results.forEach((r, i) => {
                if (r.ok) extracted.set(hidden[i].id, r.value);
                else { failed++; warn(`${hidden[i].chat_name || hidden[i].id}: ${r.error.message}`); }
            });
            log(`extraction took ${((Date.now() - started) / 1000).toFixed(1)}s`);
        } finally {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
            if (opts.keepSettings) {
                warn('--keep-settings: the account is still in proxy mode with context length 0. Normal chatting stays broken until you restore it.');
            } else {
                await closeWindow(win);
            }
        }
    }

    // Only for the cards actually being written, and only after the window is shut: lorebook
    // content is a plain public read that has no business holding the account in proxy mode.
    const writable = found.filter(d => !hasHiddenDefinition(d) || extracted.get(d.id)?.definition);
    await pool(writable, opts.concurrency, d => hydrateScripts(d, token));

    let written = 0;
    for (const detail of writable) {
        const rec = extracted.get(detail.id) || {};
        const name = detail.chat_name || detail.name || 'character';
        const file = join(opts.out, `${slugify(name, detail.id)}.json`);
        await writeFile(file, JSON.stringify(buildV2(detail, rec), null, 2), 'utf-8');
        if (opts.raw) {
            await writeFile(join(opts.out, `${slugify(name, detail.id)}.raw.json`), JSON.stringify(detail, null, 2), 'utf-8');
        }
        written++;
    }

    log(`wrote ${written} card${written === 1 ? '' : 's'} to ${opts.out}${failed ? `, ${failed} failed` : ''}`);
    return failed ? 1 : 0;
}

main()
    .then(code => process.exit(code))
    .catch(err => { console.error(`[ja-extract] ${err.message}`); process.exit(1); });
