// FreeRoam — Content Script
// Injects a sidebar overlay onto Google Maps.
// WASD keys are mapped to arrow-key simulation in the page script.
// State is read from URL, not from a panorama object.

// Nearest-pano lookup (the endpoint Maps uses for "open Street View here"); no key, no cookies
const NEAREST_PANO_URL = 'https://www.google.com/maps/photometa/si/v1?authuser=0&hl=en&gl=us&pb=!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m4!1m2!3d{LAT}!4d{LNG}!2d50!3m17!1m2!1m1!1e2!2m2!1sen!2sus!9m1!1e2!11m8!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!4m61!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!1e17!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3!11m2!3m1!4b1';
const RECENTS_MAX = 8;
const RECENT_RADIUS_M = 200;   // closer than this to the last entry = same place
const PLACE_PENDING_MS = 120000;

// Mouse sensitivity: the 10-segment bar in Settings maps to these multipliers
const SENS_STEPS = [0.3, 0.45, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const TAPE_STEP_DEG = 15;      // heading tape: one tick per 15°
const TAPE_STEP_PX = 12;

function formatDistance(m) {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.round(m * 3.28084 / 10) * 10} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi).toLocaleString()} mi`;
}

function metersBetween(a, b) {
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dx, dy);
}

function bearing(a, b) {
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

function panoUrl({ panoId, lat, lng, heading = 0, pitch = 0 }) {
    const base = 'https://www.google.com/maps/@?api=1&map_action=pano';
    const where = panoId ? `&pano=${encodeURIComponent(panoId)}` : `&viewpoint=${lat},${lng}`;
    return `${base}${where}&heading=${Math.round(heading)}&pitch=${Math.round(pitch)}`;
}

class StreetViewNavigator {
    constructor() {
        this.sidebar = null;
        this.isStreetView = false;
        this.activeKeys = new Set();
        this.lastUrl = location.href;
        this.lastState = {};
        this.settings = { mouseSens: 1, invertY: false, autoHide: true };
        this.recents = [];

        this.init();
    }

    init() {

        window.addEventListener('message', (e) => this.onMessage(e));

        chrome.storage.local.get(['settings', 'recents']).then((r) => {
            Object.assign(this.settings, r.settings || {});
            this.recents = Array.isArray(r.recents) ? r.recents : [];
            this.applySettings();
            this.renderRecents();
        }).catch(() => {});

        // Poll for Street View detection (Google Maps is a SPA)
        this.pollForStreetView();
        setInterval(() => this.pollForStreetView(), 2000);
    }

    // ── Street View Detection ──

    pollForStreetView() {
        const wasActive = this.isStreetView;
        this.isStreetView = this.detectStreetView();

        if (this.isStreetView && !this.sidebar) {
            this.injectSidebar();
            this.setupKeyboard();
            this.setupMouseLook();
        }

        if (this.isStreetView && !wasActive && this.sidebar) {
            this.updateStatus('connected', 'Click the view for mouse-look');
        }

        if (!this.isStreetView && wasActive && this.sidebar) {
            this.updateStatus('searching', 'Not in Street View');
        }

        // Save URL for background script "reopen" feature
        if (this.isStreetView && location.href !== this.lastUrl) {
            this.lastUrl = location.href;
            chrome.runtime.sendMessage({ action: 'saveUrl', url: location.href }).catch(() => {});
            this.noteRecentFromUrl();
        }

        this.checkPendingPlace();
    }

    detectStreetView() {
        const url = window.location.href;
        return /@-?[\d.]+,-?[\d.]+,[\d.]+a,[\d.]+y/.test(url);
    }

    // ── PostMessage Communication ──

    sendToPage(type, data) {
        window.postMessage({ source: 'sv-nav-content', type, data: data || null }, '*');
    }

    onMessage(event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== 'sv-nav-page') return;

        switch (msg.type) {
            case 'ready':
                this.updateStatus('connected', 'Connected');
                break;
            case 'stateUpdate':
                this.onStateUpdate(msg.data);
                break;
        }
    }

    // ── State Updates ──

    onStateUpdate(data) {
        // Record state even before the sidebar exists — pageScript only sends on change
        Object.assign(this.lastState, data);
        if (!this.sidebar) return;

        // Coords
        if (data.lat != null && data.lng != null) {
            const el = this.sidebar.querySelector('#svn-coords');
            if (el) el.textContent = `${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`;
            // Recent places show distance from here — refresh when you've moved
            if (!this.distFrom || metersBetween(this.distFrom, data) > 25) this.renderRecents();
        }

        // Heading / compass
        if (data.heading != null) {
            this.updateCompass(data.heading);
        }

        if (data.address) this.labelRecent(data.address);

        // Address
        if (data.address) {
            const el = this.sidebar.querySelector('#svn-address');
            if (el) el.textContent = data.address;
        }

        // Pitch info
        if (data.pitch != null) {
            const el = this.sidebar.querySelector('#svn-pitch');
            if (el) el.textContent = `pitch ${Math.round(data.pitch - 90)}\u00B0`;
        }
    }

    buildTape() {
        const track = this.sidebar.querySelector('#svn-tape');
        const cards = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        // Three full turns wide so the tape never runs out while sliding
        for (let deg = -360; deg < 720; deg += TAPE_STEP_DEG) {
            const n = ((deg % 360) + 360) % 360;
            const tick = document.createElement('div');
            tick.className = 'svn-tick' + (n % 45 === 0 ? ' maj' : '');
            if (n % 45 === 0) {
                const label = document.createElement('span');
                label.textContent = cards[n / 45];
                if (n === 0) label.className = 'n';
                tick.appendChild(label);
            }
            track.appendChild(tick);
        }
    }

    updateCompass(heading) {
        const track = this.sidebar.querySelector('#svn-tape');
        if (track) {
            const width = track.parentElement.clientWidth || 256;
            const h = ((heading % 360) + 360) % 360;
            const x = width / 2 - ((h + 360) / TAPE_STEP_DEG * TAPE_STEP_PX + TAPE_STEP_PX / 2);
            track.style.transform = `translateX(${x}px)`;
        }

        const hText = this.sidebar.querySelector('#svn-heading');
        if (hText) hText.textContent = `${Math.round(heading)}\u00B0`;

        const dText = this.sidebar.querySelector('#svn-direction');
        if (dText) dText.textContent = this.headingToCardinal(heading);
    }

    headingToCardinal(h) {
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        return dirs[Math.round(((h % 360) + 360) % 360 / 45) % 8];
    }

    // Status lives in the header chip: mint "STREET VIEW" / "MOUSE-LOOK" when all
    // is well, gold with the message when something needs attention.
    updateStatus(cls, text) {
        const chip = this.sidebar?.querySelector('#svn-chip');
        if (!chip) return;
        if (cls === 'connected') {
            chip.textContent = document.pointerLockElement ? 'MOUSE-LOOK' : 'STREET VIEW';
            chip.dataset.state = 'ok';
        } else {
            chip.textContent = String(text).toUpperCase();
            chip.dataset.state = 'warn';
        }
        chip.title = text;
    }

    // ── Keyboard + Mouse-Drag Controls ──

    setupKeyboard() {
        // Capture phase on window so we run before Google Maps' own handlers:
        // Street View natively reacts to W/A/S/D when its canvas is focused, and
        // we don't want native + ours to double-move. pageScript.js re-sends
        // these as arrow keys straight to the canvas (no focus/click needed).
        window.addEventListener('keydown', (e) => this.handleKey(e, true), true);
        window.addEventListener('keyup', (e) => this.handleKey(e, false), true);
        window.addEventListener('blur', () => {
            this.sidebar?.querySelectorAll('.svn-keycap.active').forEach(k => k.classList.remove('active'));
            this.sendToPage('releaseAll');
        });
    }

    handleKey(e, down) {
        if (!this.isStreetView || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

        const key = e.key.toLowerCase();
        if (key === 'h') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (down && !e.repeat) this.sidebar?.classList.toggle('collapsed');
            return;
        }
        if (key.length !== 1 || !'wasdqezx'.includes(key)) return;

        e.preventDefault();
        e.stopImmediatePropagation();
        this.highlightKey(key, down);
        this.sendToPage('keyAction', { key, down, repeat: e.repeat });
    }

    // ── Mouse-look (pointer lock, video-game style) ──
    // Click the pano → pointer locks, mouse movement turns/looks, Esc releases.
    // While locked, real mouse buttons are swallowed so a click doesn't walk
    // you somewhere (Google's click-to-move); W/S do the walking.

    getPanoCanvas() {
        let best = null, bestArea = 0;
        for (const c of document.querySelectorAll('canvas')) {
            const r = c.getBoundingClientRect();
            if (r.width * r.height > bestArea) { best = c; bestArea = r.width * r.height; }
        }
        return best;
    }

    setupMouseLook() {
        this.lookSensitivity = 1.5 * this.settings.mouseSens;
        this.crosshair = document.createElement('div');
        this.crosshair.id = 'sv-nav-crosshair';
        this.crosshair.innerHTML = '<span class="svn-ch-dot"></span><span class="svn-ch-hint"><b>ESC</b> RELEASE MOUSE</span>';
        document.body.appendChild(this.crosshair);

        // The mouse is locked onto this invisible layer of ours, never onto Google's
        // canvas: when its own canvas holds the lock, Street View switches to a raw
        // pointer-lock mode that fights our synthetic drag (the view flickers, or
        // flips upside down). Street View only ever sees our clean synthetic drag.
        this.lookLayer = document.createElement('div');
        this.lookLayer.id = 'sv-nav-looklayer';
        document.body.appendChild(this.lookLayer);

        const isLocked = () => !!document.pointerLockElement && document.pointerLockElement === this.lookLayer;

        const onButton = (e) => {
            if (!this.isStreetView || e.button !== 0 || !e.isTrusted) return;
            if (isLocked()) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            const canvas = this.getPanoCanvas();
            if (!canvas || e.target !== canvas) return;
            // First click on the pano: grab the mouse instead of walking there
            e.preventDefault();
            e.stopImmediatePropagation();
            // (preventDefault on pointerdown suppresses mousedown, so lock here)
            if (e.type === 'pointerdown') {
                const req = this.lookLayer.requestPointerLock({ unadjustedMovement: true });
                // unadjustedMovement isn't supported everywhere; fall back to plain lock
                if (req && req.catch) req.catch(() => this.lookLayer.requestPointerLock());
            }
        };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
            window.addEventListener(type, onButton, true);
        }

        // Wheel zoom goes straight in: swallow the real event and let pageScript.js
        // replay it at the center of the view (Google zooms toward the pointer,
        // which tilts the view when the pointer is low or high on the screen).
        window.addEventListener('wheel', (e) => {
            if (!this.isStreetView || !e.isTrusted) return;
            const canvas = this.getPanoCanvas();
            if (!canvas || (e.target !== canvas && !isLocked())) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            this.sendToPage('wheel', { dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, ctrl: e.ctrlKey });
        }, { capture: true, passive: false });

        // While locked, pageScript.js (document_start, ahead of Google's own
        // listeners) turns real mouse movement into the look drag and hides the
        // real moves and clicks from Maps. See "Mouse-look input" there.
        this.sendLookSettings();

        document.addEventListener('pointerlockchange', () => {
            const locked = isLocked();
            this.crosshair.classList.toggle('visible', locked);
            this.updateAutoHide();
            this.updateStatus('connected', locked ? 'Mouse-look on · Esc to release' : 'Click the view for mouse-look');
        });
        this.updateStatus('connected', 'Click the view for mouse-look');
    }

    // ── Docking ──
    // Google Maps lays itself out against the viewport, so a fixed-position
    // <body> offset by the panel width becomes its containing block: Maps
    // measures, lays out and renders into the space beside the panel and
    // nothing is covered. A resize event makes it re-measure immediately.

    updateDock() {
        const open = !!this.sidebar && !this.sidebar.classList.contains('collapsed') && !this.sidebar.classList.contains('auto-hidden');
        const html = document.documentElement;
        if (html.classList.contains('svn-docked') === open) return;
        html.classList.toggle('svn-docked', open);
        const nudge = () => window.dispatchEvent(new Event('resize'));
        nudge();
        setTimeout(nudge, 250);
    }

    // ── Panel auto-hide ──
    // While mouse-look is on the panel slides away; it comes back shortly
    // after you release the mouse. H toggles it any time.

    updateAutoHide() {
        if (!this.sidebar) return;
        const moving = !!document.pointerLockElement;
        const hide = this.settings.autoHide && moving;
        clearTimeout(this.autoHideTimer);
        if (hide) this.sidebar.classList.add('auto-hidden');
        else this.autoHideTimer = setTimeout(() => this.sidebar?.classList.remove('auto-hidden'), 700);
    }

    // ── Settings ──

    sendLookSettings() {
        this.sendToPage('lookSettings', { sens: this.lookSensitivity, invertY: !!this.settings.invertY });
    }

    applySettings() {
        const s = this.settings;
        this.lookSensitivity = 1.5 * s.mouseSens;
        this.sendLookSettings();
        if (!this.sidebar) return;
        const q = (id) => this.sidebar.querySelector(id);
        const level = this.sensLevel();
        const seg = q('#svn-set-sens');
        seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('f', i <= level));
        seg.title = `${Number(s.mouseSens).toFixed(2).replace(/0$/, '')}×`;
        seg.setAttribute('aria-valuenow', String(level + 1));
        seg.setAttribute('aria-valuetext', seg.title);
        for (const [id, on] of [['#svn-set-invert', s.invertY], ['#svn-set-autohide', s.autoHide]]) {
            q(id).setAttribute('aria-checked', String(!!on));
            q(id).textContent = on ? 'ON' : 'OFF';
        }
        if (!s.autoHide) this.sidebar.classList.remove('auto-hidden');
    }

    // Index (0–9) of the sensitivity segment closest to the current multiplier
    sensLevel() {
        let best = 0;
        SENS_STEPS.forEach((v, i) => { if (Math.abs(v - this.settings.mouseSens) < Math.abs(SENS_STEPS[best] - this.settings.mouseSens)) best = i; });
        return best;
    }

    saveSettings() {
        this.applySettings();
        chrome.storage.local.set({ settings: this.settings }).catch(() => {});
    }

    // ── Recents ──

    noteRecentFromUrl() {
        const url = location.href;
        const m = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
        if (!m) return;
        const h = url.match(/,(\d+(?:\.\d+)?)h[,/]/);
        const spot = {
            lat: parseFloat(m[1]), lng: parseFloat(m[2]),
            heading: h ? parseFloat(h[1]) : 0,
            panoId: (url.match(/!1s([A-Za-z0-9_-]{10,})/) || [])[1] || null,
        };
        const top = this.recents[0];
        if (top && metersBetween(top, spot) < RECENT_RADIUS_M) {
            Object.assign(top, spot, { time: Date.now() });
        } else {
            let label = '';
            try { label = sessionStorage.getItem('svn-next-label') || ''; sessionStorage.removeItem('svn-next-label'); } catch { /* ignore */ }
            this.recents = [{ ...spot, label, fromSearch: !!label, time: Date.now() },
                ...this.recents.filter((r) => metersBetween(r, spot) >= RECENT_RADIUS_M)].slice(0, RECENTS_MAX);
        }
        this.saveRecents();
    }

    // The current entry follows the street address as you move within it — unless
    // it's a place you searched for, which keeps the name you searched.
    labelRecent(address) {
        const top = this.recents[0];
        if (!top || top.fromSearch || top.label === address || this.lastState.lat == null) return;
        if (metersBetween(top, this.lastState) > RECENT_RADIUS_M) return;
        top.label = address;
        this.saveRecents();
    }

    saveRecents() {
        this.renderRecents();
        clearTimeout(this.recentsTimer);
        this.recentsTimer = setTimeout(() => chrome.storage.local.set({ recents: this.recents }).catch(() => {}), 1000);
    }

    renderRecents() {
        const list = this.sidebar?.querySelector('#svn-recents');
        if (!list) return;
        const ago = (t) => {
            const m = Math.round((Date.now() - t) / 60000);
            if (m < 1) return 'just now';
            if (m < 60) return `${m}m ago`;
            if (m < 1440) return `${Math.round(m / 60)}h ago`;
            return `${Math.round(m / 1440)}d ago`;
        };
        list.replaceChildren();
        if (!this.recents.length) {
            const li = document.createElement('li');
            li.className = 'svn-recents-empty';
            li.textContent = 'Places you visit show up here.';
            list.appendChild(li);
            return;
        }
        const here = this.lastState.lat != null ? { lat: this.lastState.lat, lng: this.lastState.lng } : null;
        this.distFrom = here;
        this.recents.forEach((r, i) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.className = 'svn-recent' + (i === 0 ? ' current' : '');
            btn.dataset.i = String(i);
            btn.title = `Visited ${ago(r.time)}`;
            const name = document.createElement('span');
            name.className = 'svn-recent-name';
            name.textContent = r.label || `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`;
            const meta = document.createElement('span');
            meta.className = 'svn-recent-meta';
            meta.textContent = i === 0 ? 'YOU ARE HERE' : here ? formatDistance(metersBetween(here, r)) : ago(r.time);
            btn.append(name, meta);
            li.appendChild(btn);
            list.appendChild(li);
        });
    }

    // ── Place search → Street View facing the place ──
    // Google's search lands on /maps/place/…!3dLAT!4dLNG. The nearest-pano lookup
    // at the exact spot often returns a user photo sphere (inside the building),
    // so sample a ring around the place and keep only Google street panos (type 2).

    checkPendingPlace() {
        let pending = null;
        try { pending = JSON.parse(sessionStorage.getItem('svn-pending-place') || 'null'); } catch { /* ignore */ }
        if (!pending || Date.now() - pending.t > PLACE_PENDING_MS || this.resolvingPlace) return;
        const m = location.href.match(/\/maps\/place\/([^/]+)\/.*!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
        if (!m) return;
        try { sessionStorage.removeItem('svn-pending-place'); } catch { /* ignore */ }
        const place = { lat: parseFloat(m[2]), lng: parseFloat(m[3]) };
        const name = decodeURIComponent(m[1].replace(/\+/g, ' '));
        this.resolvingPlace = true;
        this.openStreetViewAt(place, name).finally(() => { this.resolvingPlace = false; });
    }

    async nearestStreetPano(place) {
        const lookup = async (p) => {
            try {
                const url = NEAREST_PANO_URL.replace('{LAT}', p.lat.toFixed(7)).replace('{LNG}', p.lng.toFixed(7));
                const text = await (await fetch(url, { credentials: 'omit' })).text();
                const r = JSON.parse(text.slice(text.indexOf('\n') + 1))?.[1];
                const loc = r?.[5]?.[0]?.[1]?.[0];
                if (r?.[1]?.[0] !== 2 || typeof loc?.[2] !== 'number') return null; // 2 = Google street imagery
                return { panoId: r[1][1], lat: loc[2], lng: loc[3] };
            } catch { return null; }
        };
        const ring = (d) => Array.from({ length: 8 }, (_, i) => {
            const a = i * Math.PI / 4;
            return {
                lat: place.lat + (d * Math.cos(a)) / 111320,
                lng: place.lng + (d * Math.sin(a)) / (111320 * Math.cos(place.lat * Math.PI / 180)),
            };
        });
        // Prefer a pano ~35 m out (the street in front) over the absolute nearest,
        // which is often an alley or side street hugging the building's wall.
        // Big venues (arenas, stadiums) swallow the 35 m ring — then try 80 m.
        const score = (p) => Math.abs(metersBetween(place, p) - 35);
        for (const probes of [[place, ...ring(35)], ring(80)]) {
            const found = (await Promise.all(probes.map(lookup))).filter(Boolean);
            if (found.length) return found.sort((a, b) => score(a) - score(b))[0];
        }
        return null;
    }

    async openStreetViewAt(place, name) {
        try { sessionStorage.setItem('svn-next-label', name || ''); } catch { /* ignore */ }
        const pano = await this.nearestStreetPano(place);
        location.href = pano
            ? panoUrl({ panoId: pano.panoId, heading: bearing(pano, place), pitch: 5 })
            : panoUrl(place);
    }

    highlightKey(key, active) {
        if (!this.sidebar) return;
        const el = this.sidebar.querySelector(`.svn-keycap[data-key="${key}"]`);
        if (el) el.classList.toggle('active', active);
    }

    // ── Sidebar Injection ──

    injectSidebar() {
        if (this.sidebar) return;

        const sidebar = document.createElement('div');
        sidebar.id = 'sv-nav-sidebar';
        const segs = SENS_STEPS.map((v, n) => `<button type="button" data-level="${n}" aria-label="Sensitivity ${v}×"></button>`).join('');
        sidebar.innerHTML = `
            <div class="svn-top">
                <span class="svn-brand">FREEROAM</span>
                <span class="svn-chip" id="svn-chip" data-state="ok">STREET VIEW</span>
                <button class="svn-collapse-btn" id="svn-collapse" title="Hide panel (H)" aria-label="Hide panel">\u2039</button>
            </div>

            <div class="svn-tape" aria-hidden="true">
                <div class="svn-tape-marker"></div>
                <div class="svn-tape-track" id="svn-tape"></div>
            </div>
            <div class="svn-hdg">
                <b id="svn-heading">0\u00B0</b>
                <small><span id="svn-direction">N</span> \u00B7 <span id="svn-pitch">pitch 0\u00B0</span></small>
            </div>

            <section class="svn-card">
                <span class="svn-label">LOCATION</span>
                <div class="svn-place" id="svn-address">Finding your spot\u2026</div>
                <div class="svn-coords" id="svn-coords">&mdash;</div>
                <div class="svn-search">
                    <input type="text" id="svn-search" placeholder="Search a place or lat,lng" aria-label="Search a place or coordinates">
                    <button type="button" class="svn-enter" id="svn-go" title="Search (Enter)" aria-label="Search">\u21B5</button>
                </div>
            </section>

            <section class="svn-card">
                <span class="svn-label">CONTROLS</span>
                <div class="svn-ctrl">
                    <div class="svn-key-grid">
                        <div class="svn-keycap" data-key="q">Q</div>
                        <div class="svn-keycap" data-key="w">W</div>
                        <div class="svn-keycap" data-key="e">E</div>
                        <div class="svn-keycap" data-key="a">A</div>
                        <div class="svn-keycap" data-key="s">S</div>
                        <div class="svn-keycap" data-key="d">D</div>
                        <div class="svn-keycap" data-key="z">Z</div>
                        <div class="svn-keycap" data-key="x">X</div>
                    </div>
                    <div class="svn-key-legend">
                        <span><b>W S</b>move</span>
                        <span><b>A D</b>turn</span>
                        <span><b>Q E</b>look \u2191\u2193</span>
                        <span><b>Z X</b>zoom</span>
                    </div>
                </div>
                <div class="svn-ctrl-foot"><span><b>Click</b> the view to mouse-look</span><span><b>H</b> hide panel</span></div>
            </section>

            <section class="svn-card">
                <div class="svn-label svn-title-row">RECENT <button type="button" class="svn-link-btn" id="svn-recents-clear">CLEAR</button></div>
                <ol class="svn-recents" id="svn-recents"></ol>
            </section>

            <section class="svn-card svn-set">
                <div class="svn-row"><span id="svn-sens-label">Mouse sensitivity</span><div class="svn-seg" id="svn-set-sens" role="slider" tabindex="0" aria-labelledby="svn-sens-label" aria-valuemin="1" aria-valuemax="10">${segs}</div></div>
                <div class="svn-row"><span id="svn-invert-label">Invert Y</span><button type="button" class="svn-tog" id="svn-set-invert" role="switch" aria-labelledby="svn-invert-label">OFF</button></div>
                <div class="svn-row"><span id="svn-autohide-label">Hide during mouse-look</span><button type="button" class="svn-tog" id="svn-set-autohide" role="switch" aria-labelledby="svn-autohide-label">ON</button></div>
            </section>
        `;

        // Attached to <html>, not <body>: while docked, <body> (all of Google Maps)
        // is shifted into the area right of the panel — see updateDock().
        document.documentElement.appendChild(sidebar);
        this.sidebar = sidebar;

        // Expand button
        const expand = document.createElement('button');
        expand.id = 'sv-nav-expand';
        expand.textContent = '\u203A';
        expand.title = 'Show panel (H)';
        document.documentElement.appendChild(expand);

        // Dock whenever the panel is open; undock when collapsed / auto-hidden
        new MutationObserver(() => this.updateDock()).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
        this.updateDock();

        this.buildTape();
        this.bindSidebarEvents();
        this.onStateUpdate({ ...this.lastState });
        this.applySettings();
        this.renderRecents();
    }

    bindSidebarEvents() {
        // Collapse / expand
        this.sidebar.querySelector('#svn-collapse').addEventListener('click', () => {
            this.sidebar.classList.add('collapsed');
        });

        document.getElementById('sv-nav-expand').addEventListener('click', () => {
            this.sidebar.classList.remove('collapsed');
        });

        // Search — navigate via URL
        const goBtn = this.sidebar.querySelector('#svn-go');
        const searchInput = this.sidebar.querySelector('#svn-search');

        goBtn.addEventListener('click', () => this.doSearch(searchInput.value));

        searchInput.addEventListener('keydown', (e) => {
            e.stopPropagation(); // prevent WASD while typing
            if (e.key === 'Enter') this.doSearch(searchInput.value);
        });
        searchInput.addEventListener('keyup', (e) => e.stopPropagation());

        // Settings — blur after use so W/A/S/D go back to moving, not to the control
        const seg = this.sidebar.querySelector('#svn-set-sens');
        seg.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-level]');
            if (!b) return;
            this.settings.mouseSens = SENS_STEPS[+b.dataset.level];
            this.saveSettings();
            b.blur();
        });
        seg.addEventListener('keydown', (e) => {
            const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            e.stopPropagation();
            this.settings.mouseSens = SENS_STEPS[Math.max(0, Math.min(SENS_STEPS.length - 1, this.sensLevel() + step))];
            this.saveSettings();
        });
        for (const [id, key] of [['#svn-set-invert', 'invertY'], ['#svn-set-autohide', 'autoHide']]) {
            const el = this.sidebar.querySelector(id);
            el.addEventListener('click', () => { this.settings[key] = !this.settings[key]; this.saveSettings(); el.blur(); });
        }

        // Recents
        this.sidebar.querySelector('#svn-recents').addEventListener('click', (e) => {
            const btn = e.target.closest('.svn-recent');
            if (!btn) return;
            const r = this.recents[+btn.dataset.i];
            if (r) location.href = panoUrl(r);
        });
        this.sidebar.querySelector('#svn-recents-clear').addEventListener('click', (e) => {
            e.currentTarget.blur();
            this.recents = this.recents.slice(0, 1);
            this.saveRecents();
        });

    }

    doSearch(query) {
        if (!query?.trim()) return;

        // Check if it looks like coordinates
        const coordMatch = query.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
        if (coordMatch) {
            const lat = coordMatch[1];
            const lng = coordMatch[2];
            window.location.href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
        } else {
            // Google search resolves the place; checkPendingPlace() then drops you
            // into Street View facing it (or, for a list of results, after you pick one)
            try { sessionStorage.setItem('svn-pending-place', JSON.stringify({ q: query, t: Date.now() })); } catch { /* ignore */ }
            window.location.href = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        }
    }
}

new StreetViewNavigator();
