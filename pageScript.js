// FreeRoam — Page Script (MAIN world, document_start)
//
// Drives Street View by dispatching synthetic events at the pano canvas:
//   W/S/A/D → ArrowUp/Down/Left/Right KeyboardEvents (Street View's own
//             keyboard handling — true forward/back along links, smooth turning).
//             Google Maps does NOT check isTrusted on these, and they work
//             without the canvas having focus (verified 2026-09-29).
//   Q/E     → one continuous synthetic pointer drag (there's no native pitch key).
//   Mouse   → pointer-locked mouse-look, fed into the same synthetic drag.
//   Wheel, Z/X → zoom, always anchored at the center of the view.
// State (coords / heading / pitch) is parsed from the URL.

(function () {
    'use strict';

    // ── Street View detection + URL parsing ──
    // Formats seen:  /@LAT,LNG,3a,75y,90h,90t   (older / photospheres)
    //                /@LAT,LNG,24a,75y,150h,80t (current street panos)
    //                /@LAT,LNG,24a,90y,90t      (heading omitted when 0)
    const SV_URL_RE = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)a((?:,\d+(?:\.\d+)?[yht])*)/;

    function parseUrlState() {
        const m = window.location.href.match(SV_URL_RE);
        if (!m || !/y/.test(m[4])) return null;
        const state = { lat: parseFloat(m[1]), lng: parseFloat(m[2]), heading: 0, pitch: 90, fov: null };
        for (const tok of m[4].split(',').filter(Boolean)) {
            const v = parseFloat(tok);
            const unit = tok.slice(-1);
            if (unit === 'h') state.heading = v;
            else if (unit === 't') state.pitch = v;
            else if (unit === 'y') state.fov = v;
        }
        return state;
    }

    // The pano canvas's class names are obfuscated and change (was
    // `widget-scene-canvas`, now `H1VXrf`), so pick the largest visible canvas.
    // In Street View that's the pano; the minimap and offscreen canvases are smaller.
    function getCanvas() {
        let best = null, bestArea = 0;
        for (const c of document.querySelectorAll('canvas')) {
            const r = c.getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) { best = c; bestArea = area; }
        }
        return best;
    }

    // ── Keyboard: W/S/A/D → native arrow keys ──

    const ARROWS = {
        w: { key: 'ArrowUp', keyCode: 38 },
        s: { key: 'ArrowDown', keyCode: 40 },
        a: { key: 'ArrowLeft', keyCode: 37 },
        d: { key: 'ArrowRight', keyCode: 39 },
    };

    function sendArrow(key, down, repeat) {
        const canvas = getCanvas();
        const a = ARROWS[key];
        if (!canvas || !a) return;
        canvas.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
            key: a.key, code: a.key, keyCode: a.keyCode, which: a.keyCode,
            repeat: !!repeat, bubbles: true, cancelable: true, composed: true, view: window,
        }));
    }

    // ── Look: Q/E pitch + pointer-locked mouse-look ──
    // Both feed one continuous synthetic drag on the canvas. Dragging is
    // "grab the world": drag right turns left, drag down looks up. So a
    // game-style look of (dx, dy) is a drag of (-dx, -dy).

    const PITCH_PX_PER_FRAME = 4;
    // Street View's drag turns fewer degrees per pixel the further you zoom in
    // (degrees-per-pixel ∝ field of view). Scale our synthetic drags by the
    // zoom so Q/E and mouse-look turn the same angle at any zoom level.
    const REF_FOV = 75;
    function zoomScale() {
        const fov = parseUrlState()?.fov || REF_FOV;
        return Math.max(0.8, Math.min(8, REF_FOV / fov));
    }
    const LOOK_IDLE_MS = 120;
    const pitchKeys = new Set();
    let drag = null; // { canvas, x0, y0, x, y, limX, limY, last }
    let rafId = null;
    let idleTimer = null;

    function pointer(type, canvas, x, y, buttons) {
        const o = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y, button: 0, buttons,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
        };
        canvas.dispatchEvent(new PointerEvent('pointer' + type, o));
        canvas.dispatchEvent(new MouseEvent('mouse' + type, o));
    }

    function startDrag() {
        const canvas = getCanvas();
        if (!canvas) return false;
        const r = canvas.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        drag = { canvas, x0: x, y0: y, x, y, limX: r.width * 0.35, limY: r.height * 0.35 };
        pointer('down', canvas, x, y, 1);
        return true;
    }

    function endDrag() {
        if (!drag) return;
        pointer('up', drag.canvas, drag.x, drag.y, 0);
        drag = null;
    }

    function dragBy(dx, dy) {
        if (!drag && !startDrag()) return;
        drag.x += dx;
        drag.y += dy;
        pointer('move', drag.canvas, drag.x, drag.y, 1);
        // Re-grab before the virtual cursor wanders off the canvas
        if (Math.abs(drag.x - drag.x0) > drag.limX || Math.abs(drag.y - drag.y0) > drag.limY) endDrag();
    }

    function pitchLoop() {
        if (pitchKeys.size === 0) { rafId = null; if (!idleTimer) endDrag(); return; }
        const dir = (pitchKeys.has('q') ? 1 : 0) - (pitchKeys.has('e') ? 1 : 0);
        if (dir !== 0) dragBy(0, dir * PITCH_PX_PER_FRAME * zoomScale());
        rafId = requestAnimationFrame(pitchLoop);
    }

    function setPitchKey(key, down) {
        if (down) pitchKeys.add(key); else pitchKeys.delete(key);
        if (pitchKeys.size > 0 && !rafId) rafId = requestAnimationFrame(pitchLoop);
    }

    function look(dx, dy) {
        const k = zoomScale();
        dragBy(-dx * k, -dy * k);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (pitchKeys.size === 0) endDrag();
        }, LOOK_IDLE_MS);
    }

    // ── Mouse-look input (pointer locked onto content.js's #sv-nav-looklayer) ──
    // Google Maps listens for mouse moves on the window in the capture phase,
    // registered before content.js exists. While locked, the browser keeps
    // sending *real* moves pinned at the lock point; if Maps hears them they
    // fight our synthetic drag and the view flickers between two headings.
    // This script runs at document_start, so these listeners fire first: we
    // take the real movement, turn it into the look drag, and Maps never sees it.
    const LOOK_LAYER_ID = 'sv-nav-looklayer';
    const lookOpts = { sens: 1.5, invertY: false };
    const lockedByUs = () => document.pointerLockElement?.id === LOOK_LAYER_ID;
    for (const type of ['mousemove', 'pointermove', 'pointerrawupdate']) {
        window.addEventListener(type, (e) => {
            if (!e.isTrusted || !lockedByUs()) return;
            e.stopImmediatePropagation();
            if (type === 'mousemove' && (e.movementX || e.movementY)) {
                look(e.movementX * lookOpts.sens, e.movementY * lookOpts.sens * (lookOpts.invertY ? -1 : 1));
            }
        }, true);
    }
    // Real clicks while locked must not reach Maps either (a click would walk you there)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
        window.addEventListener(type, (e) => {
            if (!e.isTrusted || !lockedByUs()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }

    // ── Esc guard for mouse-look ──
    // Esc releases pointer lock (content.js), but Google Maps also treats Esc
    // as "exit Street View" via its own window-capture listener. We run at
    // document_start, so ours is registered first and can swallow it — while
    // locked and for a moment after release.
    let lockReleasedAt = 0;
    document.addEventListener('pointerlockchange', () => {
        if (!document.pointerLockElement) lockReleasedAt = performance.now();
    });
    const guardEsc = (e) => {
        if (e.key !== 'Escape') return;
        if (document.pointerLockElement || performance.now() - lockReleasedAt < 400) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, guardEsc, true);

    // ── Zoom: always toward the center of the view ──
    // Google zooms toward the mouse pointer, so zooming with the pointer low on
    // the screen also tilts the view down. content.js swallows the real wheel
    // event and we replay it at the canvas center: a straight zoom, no tilt.
    function zoomAtCenter(d) {
        const canvas = getCanvas();
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent('wheel', {
            deltaX: d.dx, deltaY: d.dy, deltaMode: d.mode, ctrlKey: !!d.ctrl,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            bubbles: true, cancelable: true, composed: true, view: window,
        }));
    }

    // Z / X: keyboard zoom for people without a scroll wheel. Held keys keep
    // zooming, using the same center-anchored wheel replay.
    const ZOOM_TICK_MS = 90;
    const zoomKeys = new Set();
    let zoomTimer = null;
    function zoomTick() {
        const dir = (zoomKeys.has('z') ? 1 : 0) - (zoomKeys.has('x') ? 1 : 0);
        if (dir) zoomAtCenter({ dx: 0, dy: -60 * dir, mode: 0, ctrl: false });
    }
    function setZoomKey(key, down) {
        if (down) {
            if (zoomKeys.has(key)) return;
            zoomKeys.add(key);
            zoomTick();
            if (!zoomTimer) zoomTimer = setInterval(zoomTick, ZOOM_TICK_MS);
        } else {
            zoomKeys.delete(key);
            if (!zoomKeys.size) { clearInterval(zoomTimer); zoomTimer = null; }
        }
    }

    // ── Communication ──

    function send(type, data) {
        window.postMessage({ source: 'sv-nav-page', type, data: data || null }, '*');
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== 'sv-nav-content') return;

        if (msg.type === 'keyAction') {
            const { key, down, repeat } = msg.data;
            if (ARROWS[key]) sendArrow(key, down, repeat);
            else if (key === 'q' || key === 'e') setPitchKey(key, down);
            else if (key === 'z' || key === 'x') setZoomKey(key, down);
        } else if (msg.type === 'lookSettings') {
            Object.assign(lookOpts, msg.data);
        } else if (msg.type === 'wheel') {
            zoomAtCenter(msg.data);
        } else if (msg.type === 'releaseAll') {
            for (const k of Object.keys(ARROWS)) sendArrow(k, false);
            pitchKeys.clear();
            setZoomKey('z', false);
            setZoomKey('x', false);
        }
    });

    // ── URL State Broadcasting ──

    let lastSent = '';
    setInterval(() => {
        const state = parseUrlState();
        const payload = state ? { streetView: true, ...state } : { streetView: false };
        const json = JSON.stringify(payload);
        if (json !== lastSent) {
            lastSent = json;
            send('stateUpdate', payload);
        }
    }, 250);

    // Place title from Street View's top-left info card (best effort — selectors are fragile)
    setInterval(() => {
        const el = document.querySelector('[data-tooltip="Copy address"]')
            || document.querySelector('.DkEaL')
            || document.querySelector('h1');
        const addr = el?.textContent?.trim();
        if (addr) send('stateUpdate', { address: addr });
    }, 2000);

    send('ready', {});
})();
