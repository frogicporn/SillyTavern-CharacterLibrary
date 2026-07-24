// DataCat avatar restore: one-shot recovery tool for cards imported while the import
// still downloaded datacat's 640px card variant. Scans datacat-linked characters,
// proposes the original-resolution avatar side by side, and swaps approved ones via
// ST's /characters/edit-avatar (re-embeds existing card JSON, so card data is untouched).

import CoreAPI from '../../core-api.js';
import { fetchDatacatCharacter, resolveDatacatAvatarUrl } from './datacat-api.js';
import { fetchWithProxy } from '../provider-utils.js';

const MODAL_ID = 'datacatAvatarRestoreModal';
const MIN_UPGRADE_RATIO = 1.2;
const SCAN_CONCURRENCY = 4;

// JanitorAI swaps moderated avatars in place at the same URL with a stock placeholder
// (the THINK shiba), so the only reliable signal is the content digest. Both digests of
// the same file: calculateHash returns sha256 in secure contexts and simpleHash on http.
const MODERATION_PLACEHOLDER_HASHES = new Set([
    'cf890801fedec1f0494ded3ba5853416b6087d142093c5c07f69bef4341510ab',
    '3ac2dcfe_50024',
]);

let injected = false;
let running = false;      // scan or apply in flight
let opToken = 0;          // bumping cancels whichever loop is running
let candidates = [];      // { avatar, name, localUrl, localW, localH, remoteUrl, remoteW, remoteH, checked, applied }
let counts = null;

function byId(id) { return document.getElementById(id); }

function injectModal() {
    if (injected) return;
    injected = true;
    const modalHtml = `
    <div id="${MODAL_ID}" class="cl-modal">
        <div class="cl-modal-content datacat-restore-content" style="max-width: calc(760px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-image"></i> Restore Original Avatars</h3>
                <button id="datacatRestoreCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body datacat-restore-body" id="datacatRestoreBody"></div>
            <div class="cl-modal-footer datacat-restore-footer" id="datacatRestoreFooter"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    byId('datacatRestoreCloseBtn')?.addEventListener('click', () => closeModal());
    byId(MODAL_ID)?.addEventListener('click', (e) => {
        if (e.target.id === MODAL_ID) closeModal();
    });
    window.registerOverlay?.({
        id: MODAL_ID,
        tier: 7,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });
}

async function closeModal() {
    if (running) {
        const confirmed = await CoreAPI.showConfirm({
            title: 'Cancel avatar restore?',
            message: 'The operation is still running. Cancel and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Cancel It',
            cancelLabel: 'Keep Running',
            danger: true,
        });
        if (!confirmed) return;
        opToken++;
        running = false;
    }
    byId(MODAL_ID)?.classList.remove('visible');
}

function openRestoreModal() {
    injectModal();
    byId(MODAL_ID)?.classList.add('visible');
    if (CoreAPI.isExtensionsRecoveryInProgress?.()) {
        byId('datacatRestoreBody').innerHTML = '<p class="datacat-restore-hint">Provider links are still being recovered from SillyTavern. Try again in a moment.</p>';
        byId('datacatRestoreFooter').innerHTML = '';
        return;
    }
    startScan();
}

function loadDims(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Dims straight from the fetched bytes (already downloaded for the hash check);
// falls back to an Image load for formats createImageBitmap won't take.
async function bufDims(buf, fallbackUrl) {
    try {
        const bmp = await createImageBitmap(new Blob([buf]));
        const dims = { w: bmp.width, h: bmp.height };
        bmp.close();
        return dims;
    } catch {
        return loadDims(fallbackUrl);
    }
}

function progressHtml(id, label) {
    return `
        <div class="datacat-restore-progress" id="${id}">
            <div class="datacat-restore-progress-text" id="${id}Text">${label}</div>
            <div class="datacat-restore-progress-bar"><div class="datacat-restore-progress-fill" id="${id}Fill"></div></div>
        </div>`;
}

// Text + fill mutate on persistent nodes so the width transition isnt reset per item.
function updateProgress(id, text, done, total) {
    const textEl = byId(`${id}Text`);
    const fillEl = byId(`${id}Fill`);
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

function renderScanProgress() {
    const body = byId('datacatRestoreBody');
    if (!body || !counts) return;
    if (!byId('datacatRestoreScanProgress')) {
        body.innerHTML = progressHtml('datacatRestoreScanProgress', 'Checking DataCat-linked characters...');
        byId('datacatRestoreFooter').innerHTML = '';
    }
    updateProgress('datacatRestoreScanProgress',
        `Checking ${counts.scanned} of ${counts.total} DataCat-linked characters... ${counts.candidates} upgradable so far.`,
        counts.scanned, counts.total);
}

async function startScan() {
    const token = ++opToken;
    running = true;
    const linked = CoreAPI.getAllCharacters().filter(c => c?.data?.extensions?.datacat?.id);
    counts = { total: linked.length, scanned: 0, candidates: 0, fine: 0, gone: 0, sanitized: 0, failed: 0 };
    candidates = [];

    if (!linked.length) {
        running = false;
        byId('datacatRestoreBody').innerHTML = '<p class="datacat-restore-hint">No DataCat-linked characters in your library.</p>';
        byId('datacatRestoreFooter').innerHTML = '';
        return;
    }
    renderScanProgress();

    const queue = [...linked];
    const workers = Array.from({ length: SCAN_CONCURRENCY }, () => (async () => {
        while (queue.length && token === opToken) {
            const char = queue.shift();
            await scanOne(char, token);
            if (token !== opToken) return;
            counts.scanned++;
            renderScanProgress();
        }
    })());
    await Promise.all(workers);

    if (token !== opToken) return;
    running = false;
    renderReview();
}

async function scanOne(char, token) {
    try {
        const ext = char.data.extensions.datacat;
        const detail = await fetchDatacatCharacter(ext.id, ext.sourceKind || null);
        if (token !== opToken) return;
        if (!detail) { counts.gone++; return; }
        const remoteUrl = resolveDatacatAvatarUrl(detail, { preferOriginal: true });
        if (!remoteUrl) { counts.gone++; return; }

        // Bytes (not an Image load) so the moderation placeholder can be hash-matched;
        // this also means every listed candidate is known fetchable before apply.
        const resp = await fetchWithProxy(remoteUrl);
        if (!resp.ok) throw new Error(`image fetch HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        if (token !== opToken) return;
        const hash = await CoreAPI.calculateHash(buf);
        if (MODERATION_PLACEHOLDER_HASHES.has(hash)) { counts.sanitized++; return; }

        const localUrl = CoreAPI.getCharacterAvatarUrl(char.avatar);
        const [localDims, remoteDims] = await Promise.all([loadDims(localUrl), bufDims(buf, remoteUrl)]);
        if (token !== opToken) return;
        if (!localDims || !remoteDims) { counts.failed++; return; }

        if (remoteDims.w >= localDims.w * MIN_UPGRADE_RATIO) {
            candidates.push({
                avatar: char.avatar,
                name: char.name || char.avatar,
                localUrl, localW: localDims.w, localH: localDims.h,
                remoteUrl, remoteW: remoteDims.w, remoteH: remoteDims.h,
                checked: true, applied: null,
            });
            counts.candidates++;
        } else {
            counts.fine++;
        }
    } catch (e) {
        console.warn('[DatacatAvatarRestore] scan failed:', char?.avatar, e.message);
        counts.failed++;
    }
}

function summaryLine() {
    const parts = [`${counts.candidates} upgradable`, `${counts.fine} already fine`];
    if (counts.sanitized) parts.push(`${counts.sanitized} skipped (avatar removed by JanitorAI moderation)`);
    if (counts.gone) parts.push(`${counts.gone} gone from the source`);
    if (counts.failed) parts.push(`${counts.failed} failed to check`);
    return parts.join(', ');
}

function renderReview() {
    const body = byId('datacatRestoreBody');
    if (!candidates.length) {
        body.innerHTML = `<p class="datacat-restore-hint">Nothing to upgrade. ${CoreAPI.escapeHtml(summaryLine())}.</p>`;
        byId('datacatRestoreFooter').innerHTML = '';
        return;
    }
    const esc = CoreAPI.escapeHtml;
    const rows = candidates.map((c, i) => `
        <div class="datacat-restore-row" data-idx="${i}">
            <label class="datacat-restore-check"><input type="checkbox" data-idx="${i}" ${c.checked ? 'checked' : ''}></label>
            <figure class="datacat-restore-side">
                <img src="${esc(c.localUrl)}" loading="lazy" decoding="async" data-view="${i}" data-start="0" alt="">
                <figcaption>${c.localW}&times;${c.localH}</figcaption>
            </figure>
            <i class="fa-solid fa-arrow-right datacat-restore-arrow"></i>
            <figure class="datacat-restore-side">
                <img src="${esc(c.remoteUrl)}" loading="lazy" decoding="async" data-view="${i}" data-start="1" alt="">
                <figcaption>${c.remoteW}&times;${c.remoteH}</figcaption>
            </figure>
            <span class="datacat-restore-name">${esc(c.name)}</span>
            <span class="datacat-restore-status" data-status-idx="${i}"></span>
        </div>`).join('');

    body.innerHTML = `
        <p class="datacat-restore-hint">${esc(summaryLine())}. Review each swap; click an image to compare both full-size. Uncheck anything that looks wrong (eg. the creator replaced the original).</p>
        <div class="datacat-restore-list">${rows}</div>`;

    body.querySelector('.datacat-restore-list').addEventListener('click', (e) => {
        const img = e.target.closest('img[data-view]');
        if (img) {
            const c = candidates[Number(img.dataset.view)];
            if (!c) return;
            CoreAPI.openGalleryViewerWithImages([
                { url: c.localUrl, name: `current ${c.localW}x${c.localH}.png` },
                { url: c.remoteUrl, name: `original ${c.remoteW}x${c.remoteH}.webp` },
            ], Number(img.dataset.start) || 0, c.name);
            return;
        }
        const check = e.target.closest('input[type="checkbox"]');
        if (check) {
            // Frozen while applying: the loop reads checked per row and the bar total is snapshotted.
            if (running) { check.checked = !check.checked; return; }
            const c = candidates[Number(check.dataset.idx)];
            if (c) c.checked = check.checked;
            updateApplyCount();
        }
    });

    byId('datacatRestoreFooter').innerHTML = `
        ${progressHtml('datacatRestoreApplyProgress', 'Applying...')}
        <div class="datacat-restore-actions" id="datacatRestoreActions">
            <button id="datacatRestoreToggleAll" class="cl-btn">Select None</button>
            <button id="datacatRestoreApplyBtn" class="cl-btn cl-btn-primary"></button>
        </div>`;
    byId('datacatRestoreApplyProgress').style.display = 'none';
    byId('datacatRestoreToggleAll').addEventListener('click', () => {
        const any = candidates.some(c => c.checked && c.applied === null);
        candidates.forEach(c => { if (c.applied === null) c.checked = !any; });
        byId('datacatRestoreBody').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            const c = candidates[Number(cb.dataset.idx)];
            if (c && c.applied === null) cb.checked = c.checked;
        });
        byId('datacatRestoreToggleAll').textContent = any ? 'Select All' : 'Select None';
        updateApplyCount();
    });
    byId('datacatRestoreApplyBtn').addEventListener('click', () => applySelected());
    updateApplyCount();
}

function updateApplyCount() {
    const btn = byId('datacatRestoreApplyBtn');
    if (!btn) return;
    const n = candidates.filter(c => c.checked && c.applied === null).length;
    btn.textContent = `Apply Selected (${n})`;
    btn.disabled = n === 0 || running;
}

function setRowStatus(i, html) {
    const el = byId('datacatRestoreBody')?.querySelector(`[data-status-idx="${i}"]`);
    if (el) el.innerHTML = html;
}

async function applySelected() {
    const token = ++opToken;
    running = true;
    updateApplyCount();
    let upgraded = 0, failed = 0, processed = 0;
    const total = candidates.filter(c => c.checked && c.applied === null).length;
    const progressEl = byId('datacatRestoreApplyProgress');
    const actionsEl = byId('datacatRestoreActions');
    if (progressEl) progressEl.style.display = '';
    if (actionsEl) actionsEl.style.display = 'none';
    updateProgress('datacatRestoreApplyProgress', `Applying avatars... 0/${total}`, 0, total);

    for (let i = 0; i < candidates.length; i++) {
        if (token !== opToken) return;
        const c = candidates[i];
        if (!c.checked || c.applied !== null) continue;
        setRowStatus(i, '<i class="fa-solid fa-spinner fa-spin"></i>');
        byId('datacatRestoreBody')?.querySelector(`.datacat-restore-row[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
        try {
            const resp = await fetchWithProxy(c.remoteUrl);
            if (!resp.ok) throw new Error(`image fetch HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            if (token !== opToken) return;

            const formData = new FormData();
            // edit-avatar re-encodes as PNG and re-embeds the existing card JSON, so the
            // source format doesnt matter and card data can't be touched by this write.
            formData.append('avatar', new File([buf], 'avatar.png', { type: 'image/png' }));
            formData.append('avatar_url', c.avatar);
            const avatarResp = await fetch('/api/characters/edit-avatar', {
                method: 'POST',
                headers: { 'X-CSRF-Token': CoreAPI.getCSRFToken() },
                body: formData,
            });
            if (!avatarResp.ok) throw new Error(`edit-avatar HTTP ${avatarResp.status}`);

            c.applied = true;
            upgraded++;
            CoreAPI.bumpAvatarCacheBust(c.avatar);
            CoreAPI.notifySTCharacterEdited(c.avatar);
            setRowStatus(i, '<i class="fa-solid fa-circle-check" style="color: var(--cl-success-bright);"></i>');
            const row = byId('datacatRestoreBody')?.querySelector(`.datacat-restore-row[data-idx="${i}"]`);
            row?.querySelector('input[type="checkbox"]')?.setAttribute('disabled', '');
        } catch (e) {
            console.error('[DatacatAvatarRestore] apply failed:', c.avatar, e);
            c.applied = false;
            failed++;
            setRowStatus(i, `<i class="fa-solid fa-circle-xmark" style="color: var(--cl-error-bright);" title="${CoreAPI.escapeHtml(e.message)}"></i>`);
        }
        processed++;
        updateProgress('datacatRestoreApplyProgress', `Applying avatars... ${processed}/${total}`, processed, total);
    }

    if (token !== opToken) return;
    running = false;
    const progressElDone = byId('datacatRestoreApplyProgress');
    const actionsElDone = byId('datacatRestoreActions');
    if (progressElDone) progressElDone.style.display = 'none';
    if (actionsElDone) actionsElDone.style.display = '';
    updateApplyCount();
    if (upgraded) CoreAPI.performSearch();
    CoreAPI.showToast(
        failed ? `Upgraded ${upgraded} avatar${upgraded !== 1 ? 's' : ''}, ${failed} failed` : `Upgraded ${upgraded} avatar${upgraded !== 1 ? 's' : ''}`,
        failed ? 'warning' : 'success', 6000,
    );
}

// Settings-panel consumer (same self-exposure family as window.datacatValidateSession).
window.datacatRestoreAvatars = openRestoreModal;

export default { openRestoreModal };
