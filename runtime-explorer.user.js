// ==UserScript==
// @name         Game Runtime Explorer
// @namespace    runtime-explorer
// @version      0.5.0
// @description  Runtime explorer for CrazyGames games: globals, scripts, WASM, HTML5, info, live tracer
// @match        *://*/*
// @all-frames   yes
// @grant        none
// @run-at       document-start
// ==/UserScript==
// Bench: tracer wraps prototypes; use Pause or Trace all: off if the game stutters.

(() => {
    'use strict';

    const OK = /(^|\.)crazygames\.com$/.test(location.hostname) ||
        (window.top !== window && document.referrer.includes('crazygames.com'));
    if (!OK || window.__re) return;
    window.__re = true;

    const KEY = 're-v4', MIN_W = 280, MIN_H = 240, M = 8, MAX_ROWS = 80, LIVE_MS = 400, DEFAULT_LIMIT = 50;
    const S = { scripts: [], wasm: [] };
    const TABS = [['globals', 'Globals'], ['scripts', 'Scripts'], ['wasm', 'WASM'], ['html5', 'HTML5'],
        ['details', 'Details'], ['tracer', 'Tracer'], ['info', 'Info']];
    const ALWAYS = 'info';
    const EMPTY = {
        globals: 'No globals found.', scripts: 'No script tags observed yet.',
        wasm: 'No WebAssembly calls observed yet.', html5: 'Nothing to show.', details: 'Click a global to inspect it.'
    };
    const ENGINES = [['Phaser', 'Phaser'], ['PIXI', 'PixiJS'], ['THREE', 'Three.js'], ['cc', 'Cocos Creator'],
        ['createjs', 'CreateJS'], ['Laya', 'LayaAir'], ['p5', 'p5.js'], ['Matter', 'Matter.js'],
        ['BABYLON', 'Babylon.js'], ['GDJS', 'GDevelop'], ['UnityLoader', 'Unity'], ['unityInstance', 'Unity'],
        ['Construct', 'Construct'], ['Kiwi', 'KiwiJS'], ['enchant', 'enchant.js'], ['ige', 'Isogenic']];

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };

    /* ---------- tracer ---------- */

    const trace = new Map();
    const wrapped = new WeakSet();
    let busy = false, paused = false, allOn = false, limit = DEFAULT_LIMIT;

    const fmt = v => {
        if (v === null) return 'null';
        const t = typeof v;
        if (t === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
        if (t === 'symbol') return 'Symbol';
        if (t === 'function') return 'fn';
        if (t !== 'object') return String(v);
        if (Array.isArray(v)) return `[${v.length}]`;
        return safe(() => (v.constructor?.name || 'Object') + '{}', '{…}');
    };

    function bump(m, c, args) {
        if (busy || paused) return;
        const k = `${m}(${c})`;
        let e = trace.get(k);
        if (!e) trace.set(k, e = { n: 0, t: 0, a: '' });
        if (e.n >= limit) return;
        e.n++;
        e.t = Date.now();
        e.a = safe(() => Array.prototype.slice.call(args, 0, 3).map(fmt).join(', ').slice(0, 160), '');
    }

    function wrap(proto, cls, gated) {
        if (!proto || typeof proto !== 'object' || wrapped.has(proto)) return;
        wrapped.add(proto);
        for (const n of Object.getOwnPropertyNames(proto)) {
            if (n === 'constructor') continue;
            const d = Object.getOwnPropertyDescriptor(proto, n);
            if (!d || typeof d.value !== 'function') continue;
            const f = d.value;
            try {
                Object.defineProperty(proto, n, {
                    ...d,
                    value: function (...a) {
                        if (!gated || allOn) bump(n, cls, a);
                        return Reflect.apply(f, this, a);
                    }
                });
            } catch { /* non-configurable */ }
        }
    }

    for (const c of ['CanvasRenderingContext2D', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'Node', 'Element',
        'Document', 'XMLHttpRequest', 'WebSocket', 'AudioContext', 'Storage', 'Performance']) {
        wrap(safe(() => window[c].prototype), c, false);
    }

    const origFetch = window.fetch;
    if (origFetch) window.fetch = function (...a) { bump('fetch', 'Window', a); return Reflect.apply(origFetch, this, a); };

    function setAll(on) {
        allOn = on;
        if (!on) return;
        for (const k of Object.getOwnPropertyNames(window)) {
            const f = safe(() => Object.getOwnPropertyDescriptor(window, k)?.value);
            if (typeof f === 'function' && f.prototype) wrap(f.prototype, k, true);
        }
    }

    /* ---------- WASM + scripts ---------- */

    const describeSrc = s => {
        if (typeof s === 'string') return s.slice(0, 150);
        if (s && typeof s.url === 'string') return (s.url || 'Response').slice(0, 150);
        if (s && s.byteLength != null) return `bytes ${s.byteLength}`;
        return safe(() => String(s).slice(0, 150), '?');
    };

    const W = WebAssembly;
    for (const k of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) {
        const of = W[k];
        if (typeof of !== 'function') continue;
        W[k] = function (src, ...r) {
            S.wasm.push({ k, src: describeSrc(src) });
            bump(k, 'WebAssembly', [src]);
            return Reflect.apply(of, this, [src, ...r]);
        };
    }
    if (W.Module) {
        W.Module = new Proxy(W.Module, {
            construct(t, a) {
                S.wasm.push({ k: 'Module', src: describeSrc(a[0]) });
                bump('Module', 'WebAssembly', a);
                return Reflect.construct(t, a);
            }
        });
    }

    new MutationObserver(() => {
        document.querySelectorAll('script[src]').forEach(s => {
            if (s.src && !S.scripts.includes(s.src)) S.scripts.push(s.src);
        });
    }).observe(document, { childList: true, subtree: true });

    /* ---------- inspection ---------- */

    function globalsList() {
        const out = [];
        for (const name of Object.getOwnPropertyNames(window)) {
            safe(() => {
                const d = Object.getOwnPropertyDescriptor(window, name);
                if (!d) return;
                const t = 'value' in d ? (d.value === null ? 'null' : typeof d.value) : 'accessor';
                if (['function', 'object', 'accessor'].includes(t)) out.push({ name, type: t });
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    function details(name) {
        const d = Object.getOwnPropertyDescriptor(window, name);
        if (!d) return [];
        if (!('value' in d)) return [{ name, type: 'accessor (not invoked)' }];
        const out = [], seen = new Set();
        let o = d.value;
        for (let depth = 0; o && (typeof o === 'object' || typeof o === 'function') && depth < 5; depth++) {
            for (const k of Object.getOwnPropertyNames(o)) {
                if (seen.has(k)) continue;
                seen.add(k);
                const p = safe(() => Object.getOwnPropertyDescriptor(o, k));
                if (p) out.push({ name: k, type: 'value' in p ? typeof p.value : 'accessor' });
            }
            o = safe(() => Object.getPrototypeOf(o), null);
        }
        return out;
    }

    let glStr;
    function webgl() {
        if (glStr !== undefined) return glStr;
        glStr = safe(() => {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return 'unsupported';
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            const r = `${gl.getParameter(gl.VERSION)} · ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'renderer hidden'}`;
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            return r;
        }, 'error');
        return glStr;
    }

    function engines() {
        const seen = new Map();
        for (const [g, label] of ENGINES) {
            if (seen.has(label)) continue;
            safe(() => {
                const o = window[g];
                if (o == null) return;
                const v = o.VERSION ?? o.REVISION ?? o.version ?? o.ENGINE_VERSION ?? o.Engine?.Version;
                seen.set(label, v ? String(v) : 'unknown');
            });
        }
        return [...seen];
    }

    function html5Rows() {
        const canvases = [...document.querySelectorAll('canvas')];
        const eng = engines();
        return [
            ['HTML5 game', canvases.length || eng.length ? 'yes' : 'no'],
            ['Engine', eng.map(([n]) => n).join(', ') || 'not detected'],
            ['Canvases', canvases.map(c => `${c.width}×${c.height}`).join(', ') || 'none'],
            ['WebGL', webgl()],
            ['Scripts', S.scripts.length],
            ['WASM calls', S.wasm.length],
            ['Frames', window.frames.length],
            ['In iframe', window.top !== window ? 'yes' : 'no'],
            ['Viewport', `${innerWidth}×${innerHeight} @${devicePixelRatio}`],
            ['Title', document.title || '-'],
            ['URL', location.href.slice(0, 120)],
            ['localStorage keys', safe(() => localStorage.length, 'blocked')],
            ['UA', navigator.userAgent.slice(0, 90)]
        ].map(([name, type]) => ({ name, type: String(type) }));
    }

    const LISTS = {
        globals: globalsList,
        scripts: () => S.scripts.map(name => ({ name, type: 'script' })),
        wasm: () => S.wasm.map((w, i) => ({ name: `${w.k} #${i + 1}`, type: w.src })),
        html5: html5Rows,
        details: () => (sel ? details(sel) : [])
    };

    /* ---------- layout ---------- */

    function defaultLayout() {
        const w = Math.min(380, innerWidth - M * 2), h = Math.min(500, innerHeight - M * 2);
        return { x: Math.max(M, innerWidth - w - 20), y: 20, w, h, open: true, traceOn: true, hidden: [] };
    }
    const loadLayout = () => ({ ...defaultLayout(), ...safe(() => JSON.parse(localStorage.getItem(KEY)), {}) });
    const save = () => safe(() => localStorage.setItem(KEY, JSON.stringify(layout)));

    /* ---------- DOM ---------- */

    const host = document.createElement('div');
    host.id = 'runtime-explorer-host';
    Object.assign(host.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', zIndex: '2147483647',
        pointerEvents: 'none', margin: '0', padding: '0', border: '0'
    });
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; }
            .glass {
                background: linear-gradient(160deg, rgba(255,255,255,.16), rgba(255,255,255,.03) 40%, rgba(255,255,255,.08)), rgba(16,18,26,.52);
                -webkit-backdrop-filter: blur(30px) saturate(190%); backdrop-filter: blur(30px) saturate(190%);
                border: 1px solid rgba(255,255,255,.14);
                box-shadow: 0 24px 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.28);
            }
            .launcher {
                position: fixed; right: 20px; bottom: 20px; width: 46px; height: 46px; border-radius: 50%;
                display: grid; place-items: center; padding: 0; color: #f2f4f8; font: 18px system-ui; cursor: pointer;
                background: linear-gradient(145deg, rgba(255,255,255,.22), rgba(255,255,255,.04)), rgba(20,22,30,.55);
                -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
                border: 1px solid rgba(255,255,255,.18); box-shadow: 0 10px 30px rgba(0,0,0,.45);
                opacity: 0; scale: .6; pointer-events: none; transition: opacity .25s, scale .35s cubic-bezier(.2,.8,.2,1);
            }
            .launcher.show { opacity: 1; scale: 1; pointer-events: auto; }
            .panel {
                position: fixed; top: 0; left: 0; min-width: ${MIN_W}px; min-height: ${MIN_H}px;
                display: flex; flex-direction: column; overflow: hidden; border-radius: 22px; color: #eef1f6;
                font: 12px ui-monospace, Menlo, monospace; pointer-events: auto; transform-origin: top left;
                transition: scale .35s cubic-bezier(.2,.8,.2,1), opacity .25s; will-change: transform;
            }
            .panel.closed { opacity: 0; scale: .9; pointer-events: none; }
            .moving { transition: none !important; }
            .hd {
                position: relative; display: flex; align-items: center; justify-content: space-between;
                padding: 14px 12px 10px; cursor: grab; touch-action: none; user-select: none;
                border-bottom: 1px solid rgba(255,255,255,.08);
            }
            .grip {
                position: absolute; left: 50%; top: 5px; width: 28px; height: 4px; border-radius: 4px;
                background: rgba(255,255,255,.25); transform: translateX(-50%);
            }
            .title { font: 600 13px system-ui; }
            .btn {
                display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; padding: 0;
                color: #eef1f6; font: 14px system-ui; cursor: pointer;
                background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14);
            }
            .btn:hover { background: rgba(255,255,255,.2); }
            input[type=text], input:not([type]), input[type=number] {
                padding: 6px 8px; font: inherit; color: #f2f4f8; outline: none;
                background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
            }
            input:focus { border-color: rgba(140,180,255,.6); }
            #search { margin: 10px 10px 6px; }
            .tabs { display: flex; flex-wrap: wrap; gap: 3px; padding: 4px 8px 6px; }
            .tab {
                flex: 1 0 auto; min-width: 0; padding: 6px 4px; font: 10.5px system-ui; color: rgba(255,255,255,.7);
                background: transparent; border: 1px solid transparent; border-radius: 10px; cursor: pointer;
            }
            .tab.active { color: #fff; background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.18); }
            .bar {
                display: flex; align-items: center; justify-content: space-between; gap: 8px;
                margin: 2px 10px 0; padding: 6px 8px; border-radius: 12px; font: 11px system-ui;
                background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
            }
            .bar[hidden] { display: none; }
            .bar input { width: 60px; padding: 4px 6px; font: 11px system-ui; }
            .toggle {
                padding: 5px 10px; font: 11px system-ui; color: #eef1f6; cursor: pointer; border-radius: 8px;
                background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14);
            }
            .toggle.on { background: rgba(120,200,140,.28); border-color: rgba(120,200,140,.5); }
            .content {
                flex: 1; overflow: auto; margin: 2px 10px 6px; padding: 4px; border-radius: 14px;
                background: rgba(0,0,0,.18); border: 1px solid rgba(255,255,255,.06);
            }
            .item {
                padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.05); border-radius: 8px;
                overflow-wrap: anywhere; cursor: pointer;
            }
            .item:hover { background: rgba(255,255,255,.08); }
            .sec { padding: 8px 8px 4px; color: rgba(255,255,255,.5); font-size: 10px; letter-spacing: .5px; text-transform: uppercase; }
            .chk { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
            .chk:hover { background: rgba(255,255,255,.08); }
            .chk input { accent-color: #4ade80; }
            .empty { padding: 12px; color: rgba(255,255,255,.45); }
            .error { padding: 12px; color: #ffb4b4; overflow-wrap: anywhere; }
            .trow { padding: 4px 6px; border-radius: 6px; }
            .trow:nth-child(odd) { background: rgba(255,255,255,.03); }
            .thead { display: flex; justify-content: space-between; gap: 8px; white-space: nowrap; }
            .name { overflow: hidden; text-overflow: ellipsis; color: #fff; transition: color 1.2s, text-shadow 1.2s; }
            .trow.live .name {
                color: #4ade80; text-shadow: 0 0 8px rgba(74,222,128,.55); transition: color .08s, text-shadow .08s;
            }
            .count { color: rgba(255,255,255,.6); }
            .args { color: rgba(255,255,255,.4); font-size: 10px; overflow-wrap: anywhere; margin-top: 2px; }
            footer { padding: 8px 14px 12px; color: rgba(255,255,255,.35); font-size: 10px; }
            .resize {
                position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none;
                background: linear-gradient(135deg, transparent 0 50%, rgba(255,255,255,.35) 50% 56%, transparent 56% 66%, rgba(255,255,255,.35) 66% 72%, transparent 72%);
            }
            .strip {
                position: fixed; top: 50%; right: 0; transform: translateY(-50%); width: 230px; max-height: 70vh;
                display: flex; flex-direction: column; overflow: hidden; border-radius: 16px 0 0 16px; border-right: none;
                color: #eef1f6; font: 11px ui-monospace, Menlo, monospace; pointer-events: auto;
                transition: transform .35s cubic-bezier(.2,.8,.2,1), opacity .25s;
            }
            .strip.hidden { transform: translate(100%, -50%); opacity: 0; pointer-events: none; }
            .sh {
                display: flex; justify-content: space-between; align-items: center; padding: 10px 10px 8px 12px;
                border-bottom: 1px solid rgba(255,255,255,.08); font: 600 11px system-ui;
            }
            .sb { display: flex; gap: 4px; }
            .sb button {
                font: 10px system-ui; color: #eef1f6; padding: 3px 7px; cursor: pointer; border-radius: 8px;
                background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14);
            }
            .slist { overflow: auto; padding: 6px 8px 8px; }
            .strip .args { display: none; }
            .stab {
                position: fixed; top: 50%; right: 0; transform: translateY(-50%); width: 22px; height: 64px;
                display: grid; place-items: center; cursor: pointer; color: #eef1f6; border-radius: 12px 0 0 12px;
                background: rgba(16,18,26,.55); border: 1px solid rgba(255,255,255,.14); border-right: none;
                opacity: 0; pointer-events: none; transition: opacity .25s;
            }
            .stab.show { opacity: 1; pointer-events: auto; }
        </style>

        <button class="launcher" id="launch" title="Open (Alt+Shift+R)">◉</button>

        <section class="panel glass" id="panel">
            <header class="hd" id="hd">
                <span class="grip"></span>
                <span class="title">Runtime Explorer</span>
                <button class="btn" id="close" title="Close (Esc)">×</button>
            </header>
            <input id="search" placeholder="Search…" autocomplete="off" spellcheck="false">
            <nav class="tabs" id="tabs"></nav>
            <div class="bar" id="bar" hidden>
                <label>Limit <input id="limit" type="number" min="1" value="${DEFAULT_LIMIT}"></label>
                <button class="toggle" id="all">Trace all: off</button>
            </div>
            <div class="content" id="content"></div>
            <footer>GAME RUNTIME INSPECTOR v0.5.0</footer>
            <div class="resize" id="resize"></div>
        </section>

        <aside class="strip glass hidden" id="strip">
            <div class="sh">
                <span>Tracer</span>
                <div class="sb">
                    <button id="pause">Pause</button>
                    <button id="clear">Clear</button>
                    <button id="hide">▸</button>
                </div>
            </div>
            <div class="slist" id="slist"></div>
        </aside>
        <div class="stab" id="stab" title="Show tracer (Alt+Shift+T)">◂</div>
    `;

    const $ = id => root.getElementById(id);
    const panel = $('panel'), launcher = $('launch'), hd = $('hd'), grip = $('resize'), content = $('content');
    const search = $('search'), tabsEl = $('tabs'), bar = $('bar'), limitIn = $('limit'), allBtn = $('all');
    const strip = $('strip'), stab = $('stab'), slist = $('slist'), pauseBtn = $('pause');

    const layout = loadLayout();
    let tab = 'globals', sel = null, raf = 0;
    const tRows = new Map(), sRows = new Map();

    const isHidden = k => k !== ALWAYS && layout.hidden.includes(k);

    /* ---------- layout + open/close ---------- */

    function clampLayout() {
        layout.w = Math.min(Math.max(layout.w, MIN_W), Math.max(MIN_W, innerWidth - M * 2));
        layout.h = Math.min(Math.max(layout.h, MIN_H), Math.max(MIN_H, innerHeight - M * 2));
        layout.x = Math.min(Math.max(layout.x, M), Math.max(M, innerWidth - layout.w - M));
        layout.y = Math.min(Math.max(layout.y, M), Math.max(M, innerHeight - layout.h - M));
    }

    function applyLayout() {
        clampLayout();
        Object.assign(panel.style, {
            width: layout.w + 'px', height: layout.h + 'px', transform: `translate3d(${layout.x}px,${layout.y}px,0)`
        });
        panel.classList.toggle('closed', !layout.open);
        launcher.classList.toggle('show', !layout.open);
    }

    function scheduleApply() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; applyLayout(); });
    }

    function setOpen(open) {
        layout.open = open;
        applyLayout();
        save();
        if (open) { render(); search.focus({ preventScroll: true }); }
    }

    function setTraceVisible(on) {
        layout.traceOn = on;
        strip.classList.toggle('hidden', !on);
        stab.classList.toggle('show', !on);
        save();
        if (on) renderStrip();
    }

    /* ---------- tabs ---------- */

    function renderTabs() {
        tabsEl.replaceChildren(...TABS.filter(([k]) => !isHidden(k)).map(([k, l]) => {
            const b = el('button', 'tab' + (k === tab ? ' active' : ''), l);
            b.dataset.tab = k;
            return b;
        }));
    }

    function setTab(t) {
        if (isHidden(t)) t = 'globals';
        tab = t;
        if (t !== 'details') sel = null;
        search.value = '';
        renderTabs();
        render();
        content.scrollTop = 0;
    }

    function toggleTab(k, show) {
        layout.hidden = show ? layout.hidden.filter(x => x !== k) : [...new Set([...layout.hidden, k])];
        save();
        if (isHidden(tab)) setTab('globals');
        else renderTabs();
    }

    /* ---------- drag + resize ---------- */

    function track(target, onDown, onMove) {
        target.addEventListener('pointerdown', e => {
            if (e.button || e.target.closest('button')) return;
            e.preventDefault();
            target.setPointerCapture(e.pointerId);
            panel.classList.add('moving');
            onDown(e);
        });
        target.addEventListener('pointermove', e => {
            if (target.hasPointerCapture(e.pointerId)) { onMove(e); scheduleApply(); }
        });
        const up = () => { panel.classList.remove('moving'); save(); };
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
    }

    let ox, oy, sx, sy, sw, sh;
    track(hd,
        e => { ox = e.clientX - layout.x; oy = e.clientY - layout.y; },
        e => { layout.x = e.clientX - ox; layout.y = e.clientY - oy; });
    track(grip,
        e => { sx = e.clientX; sy = e.clientY; sw = layout.w; sh = layout.h; },
        e => { layout.w = sw + e.clientX - sx; layout.h = sh + e.clientY - sy; });

    /* ---------- tracer rows ---------- */

    function traceRows(q = '') {
        return [...trace.entries()]
            .filter(([k, e]) => !q || k.toLowerCase().includes(q) || e.a.toLowerCase().includes(q))
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, MAX_ROWS);
    }

    function paint(box, cache, rows, emptyText) {
        box.querySelector(':scope > .empty')?.remove();
        if (!rows.length) {
            cache.clear();
            return box.replaceChildren(el('div', 'empty', emptyText));
        }
        const now = Date.now(), keep = new Set();
        rows.forEach(([k, e], i) => {
            let r = cache.get(k);
            if (!r) {
                const row = el('div', 'trow'), head = el('div', 'thead');
                const name = el('span', 'name'), cnt = el('span', 'count'), args = el('div', 'args');
                head.append(name, cnt);
                row.append(head, args);
                cache.set(k, r = { row, name, cnt, args });
            }
            keep.add(k);
            r.name.textContent = k;
            r.cnt.textContent = `| ${e.n}${e.n >= limit ? ' · max' : ''}`;
            r.args.textContent = e.a;
            r.row.classList.toggle('live', now - e.t < LIVE_MS);
            if (box.children[i] !== r.row) box.insertBefore(r.row, box.children[i] || null);
        });
        for (const [k, r] of cache) if (!keep.has(k)) { r.row.remove(); cache.delete(k); }
        while (box.children.length > rows.length) box.lastChild.remove();
    }

    function renderStrip() {
        if (!layout.traceOn) return;
        busy = true;
        try { paint(slist, sRows, traceRows(), 'No calls yet.'); } finally { busy = false; }
    }

    /* ---------- info + settings ---------- */

    function infoView() {
        const eng = engines();
        const sec = t => el('div', 'sec', t);
        const kv = (a, b) => el('div', 'item', `${a}  [${b}]`);
        const nodes = [sec('Engine')];
        if (!eng.length) nodes.push(kv('Engine', 'not detected'));
        for (const [n, v] of eng) nodes.push(kv(n, v));
        nodes.push(kv('Tracer calls', [...trace.values()].reduce((s, e) => s + e.n, 0)));
        nodes.push(sec('Show tabs'));
        for (const [k, l] of TABS) {
            if (k === ALWAYS) continue;
            const row = el('label', 'chk');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = !isHidden(k);
            cb.addEventListener('change', () => toggleTab(k, cb.checked));
            row.append(cb, el('span', null, l));
            nodes.push(row);
        }
        return nodes;
    }

    /* ---------- explorer render ---------- */

    function render() {
        busy = true;
        try {
            bar.hidden = tab !== 'tracer';
            const q = search.value.toLowerCase();
            if (tab === 'tracer') return paint(content, tRows, traceRows(q), q ? 'No matches.' : 'No calls yet.');
            tRows.clear();
            if (tab === 'info') return content.replaceChildren(...infoView());

            let items;
            try {
                items = LISTS[tab]().filter(i => `${i.name} ${i.type}`.toLowerCase().includes(q));
            } catch (e) {
                return content.replaceChildren(el('div', 'error', 'Render error: ' + (e?.message || e)));
            }
            if (!items.length) return content.replaceChildren(el('div', 'empty', q ? 'No matches.' : EMPTY[tab]));
            content.replaceChildren(...items.map(i => {
                const d = el('div', 'item', `${i.name}  [${i.type}]`);
                if (tab === 'globals') d.onclick = () => { sel = i.name; setTab('details'); };
                return d;
            }));
        } finally {
            busy = false;
        }
    }

    function scheduleRender() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; render(); });
    }

    /* ---------- wiring ---------- */

    tabsEl.addEventListener('click', e => {
        const b = e.target.closest('.tab');
        if (b) setTab(b.dataset.tab);
    });
    search.addEventListener('input', render);
    launcher.addEventListener('click', () => setOpen(true));
    $('close').addEventListener('click', () => setOpen(false));

    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    });
    $('clear').addEventListener('click', () => { trace.clear(); renderStrip(); if (tab === 'tracer') render(); });
    $('hide').addEventListener('click', () => setTraceVisible(false));
    stab.addEventListener('click', () => setTraceVisible(true));

    allBtn.addEventListener('click', () => {
        const on = !allOn;
        setAll(on);
        allBtn.textContent = on ? 'Trace all: on' : 'Trace all: off';
        allBtn.classList.toggle('on', on);
        if (tab === 'tracer') render();
    });

    limitIn.addEventListener('change', () => {
        const n = parseInt(limitIn.value, 10);
        limit = n > 0 ? n : DEFAULT_LIMIT;
        limitIn.value = limit;
        if (tab === 'tracer') render();
    });

    document.addEventListener('keydown', e => {
        if (!e.altKey || !e.shiftKey) {
            if (e.key === 'Escape' && layout.open) setOpen(false);
            return;
        }
        const k = e.key.toLowerCase();
        if (k === 'r') { e.preventDefault(); setOpen(!layout.open); }
        if (k === 't') { e.preventDefault(); setTraceVisible(!layout.traceOn); }
    });

    addEventListener('resize', scheduleApply);

    /* ---------- boot ---------- */

    const boot = setInterval(() => {
        if (!document.documentElement) return;
        clearInterval(boot);
        document.documentElement.append(host);
        renderTabs();
        applyLayout();
        setTraceVisible(layout.traceOn);
        render();
        setInterval(() => {
            if (layout.open) scheduleRender();
            renderStrip();
        }, 250);
    }, 50);
})();
