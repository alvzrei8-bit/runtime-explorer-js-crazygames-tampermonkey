// ==UserScript==
// @name         Chess.com Helper (local Stockfish)
// @namespace    venice.chess.helper
// @version      1.1.0
// @description  Local Stockfish analysis overlay for chess.com with humanizer: jittered reveal, line-2/3 bias, match-rate tracking, optional auto-move.
// @author       Venice
// @match        https://www.chess.com/*
// @match        https://chess.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    enabled:     GM_getValue('enabled', true),
    depth:       GM_getValue('depth', 12),
    multiPV:     GM_getValue('multiPV', 3),
    showBar:     GM_getValue('showBar', true),
    arrow:       GM_getValue('arrow', true),
    humanize:    GM_getValue('humanize', true),
    onlyOurTurn: GM_getValue('onlyOurTurn', true),
    delayMin:    GM_getValue('delayMin', 900),
    delayMax:    GM_getValue('delayMax', 4200),
    secondBias:  GM_getValue('secondBias', 0.35),
    threshold:   GM_getValue('threshold', 60),
    autoMove:    GM_getValue('autoMove', false),
    eventStyle:  GM_getValue('eventStyle', 'pointer'),
  };

  const save = () => Object.keys(CFG).forEach((k) => GM_setValue(k, CFG[k]));

  const ENGINE_URLS = [
    'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
    'https://unpkg.com/stockfish.js@10.0.2/stockfish.js',
  ];

  const TICK_MS = 250;
  const FILES = 'abcdefgh';
  const PIECE_CLASSES = ['wp', 'wn', 'wb', 'wr', 'wq', 'wk', 'bp', 'bn', 'bb', 'br', 'bq', 'bk'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  GM_addStyle(`
    #cch-canvas { position: fixed; pointer-events: none; z-index: 99998; display: none; border-radius: 4px; }
    #cch-bar { position: fixed; width: 14px; z-index: 99997; display: none;
      background: #1a1a1a; border: 1px solid #444; border-radius: 3px; overflow: hidden; }
    #cch-bar > i { position: absolute; left: 0; right: 0; bottom: 0; display: block;
      background: #f2f2f2; height: 50%; transition: height .18s linear; }
    #cch-hud { position: fixed; top: 90px; right: 18px; z-index: 99999; width: 214px;
      font: 12px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #e8e8e8; background: rgba(18,18,18,.94);
      border: 1px solid #3a3a3a; border-radius: 8px;
      box-shadow: 0 6px 22px rgba(0,0,0,.55); user-select: none; }
    #cch-hud .hd { padding: 7px 9px; cursor: grab; border-bottom: 1px solid #333;
      display: flex; justify-content: space-between; align-items: center;
      font-weight: 700; letter-spacing: .04em; color: #9fd69f; }
    #cch-hud .hd:active { cursor: grabbing; }
    #cch-hud .bd { padding: 8px 9px 9px; }
    #cch-hud .row { display: flex; justify-content: space-between; gap: 6px; padding: 2px 0; }
    #cch-hud .k { color: #8a8a8a; }
    #cch-hud .v { color: #fff; font-weight: 700; }
    #cch-hud .best { color: #9fd69f; }
    #cch-hud .warn { color: #ffcf7a; }
    #cch-hud .err { color: #ff9b9b; }
    #cch-hud .btns { display: flex; gap: 5px; margin-top: 8px; }
    #cch-hud button { flex: 1; font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;
      color: #ddd; background: #262626; border: 1px solid #3d3d3d; border-radius: 5px; }
    #cch-hud button:hover { background: #333; }
    #cch-hud button.on { background: #2f5d2f; border-color: #4d8a4d; color: #d9ffd9; }
    #cch-hud.min .bd { display: none; }
  `);

  let engine = null;
  let engineState = 'idle';
  let lines = [];

  function handshake(w) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('engine timeout')), 20000);
      w.onmessage = (e) => {
        const d = typeof e.data === 'string' ? e.data : '';
        if (d.indexOf('uciok') !== -1) {
          clearTimeout(t);
          resolve();
        }
      };
      w.onerror = () => {
        clearTimeout(t);
        reject(new Error('worker error'));
      };
      w.postMessage('uci');
    });
  }

  async function loadEngine() {
    if (engineState !== 'idle') return;
    engineState = 'loading';
    renderHud();

    for (const url of ENGINE_URLS) {
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) continue;
        const src = await res.text();
        if (src.length < 10000) continue;

        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
        await handshake(w);

        w.onmessage = onEngineMessage;
        w.postMessage('setoption name Threads value 1');
        w.postMessage('setoption name Hash value 32');
        w.postMessage('setoption name MultiPV value ' + CFG.multiPV);
        w.postMessage('ucinewgame');
        w.postMessage('isready');

        engine = w;
        engineState = 'ready';
        renderHud();
        return;
      } catch (err) {}
    }

    engineState = 'failed';
    renderHud();
  }

  function onEngineMessage(e) {
    const msg = typeof e.data === 'string' ? e.data : '';
    if (!msg) return;

    if (msg.indexOf('info') === 0 && msg.indexOf(' pv ') !== -1) {
      const depth = /(?:^|\s)depth (\d+)/.exec(msg);
      const mpv = /multipv (\d+)/.exec(msg);
      const cp = /score cp (-?\d+)/.exec(msg);
      const mate = /score mate (-?\d+)/.exec(msg);
      const pv = / pv (.+)$/.exec(msg);
      if (!pv) return;

      const idx = mpv ? parseInt(mpv[1], 10) : 1;
      const entry = {
        multipv: idx,
        depth: depth ? parseInt(depth[1], 10) : 0,
        score: cp ? parseInt(cp[1], 10) : null,
        mate: mate ? parseInt(mate[1], 10) : null,
        pv: pv[1].trim().split(/\s+/).filter((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)),
      };

      lines = lines.filter((l) => l.multipv !== idx);
      lines.push(entry);
      lines.sort((a, b) => a.multipv - b.multipv);
      return;
    }

    if (msg.indexOf('bestmove') === 0 && lines.length === 0) {
      const m = /bestmove (\S+)/.exec(msg);
      if (m && m[1] !== '(none)') {
        lines.push({ multipv: 1, depth: 0, score: null, mate: null, pv: [m[1]] });
      }
    }
  }

  function analyze(fen) {
    if (!engine || engineState !== 'ready') return;
    lines = [];
    engine.postMessage('stop');
    engine.postMessage('position fen ' + fen);
    engine.postMessage('go depth ' + CFG.depth);
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && el.offsetParent !== null;
  }

  function findBoard() {
    const boards = Array.from(document.querySelectorAll('wc-chess-board, #board-single, .board')).filter(visible);
    if (!boards.length) return null;
    boards.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return boards[0];
  }

  const isFlipped = (board) =>
    board.classList.contains('flipped') || !!board.closest('.flipped');

  const ourColor = (board) => (isFlipped(board) ? 'b' : 'w');

  function readPieces(board) {
    const map = new Map();
    board.querySelectorAll('.piece').forEach((el) => {
      let sq = null;
      const sqClass = Array.from(el.classList).find((c) => /^square-[1-8][1-8]$/.test(c));
      if (sqClass) {
        const d = sqClass.slice(7);
        sq = FILES[parseInt(d[0], 10) - 1] + (9 - parseInt(d[1], 10));
      } else {
        const ds = el.getAttribute('data-square');
        if (ds && /^[a-h][1-8]$/.test(ds)) sq = ds;
      }
      if (!sq) return;

      const cls = Array.from(el.classList);
      const code = PIECE_CLASSES.find((c) => cls.includes(c));
      if (!code) return;

      map.set(sq, code[0] === 'w' ? code[1].toUpperCase() : code[1]);
    });
    return map;
  }

  function getSanHistory() {
    const nodes = document.querySelectorAll(
      '.move-list .node-highlight-content, .vertical-move-list .node-highlight-content, [class*="node-highlight-content"]'
    );
    const out = [];
    nodes.forEach((n) => {
      const t = (n.textContent || '').trim().replace(/\s+/g, '');
      if (/^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?)$/.test(t)) out.push(t);
    });
    return out;
  }

  function getTurn(history) {
    if (document.querySelector('.clock-white.clock-player-turn')) return 'w';
    if (document.querySelector('.clock-black.clock-player-turn')) return 'b';
    return history.length % 2 === 0 ? 'w' : 'b';
  }

  function readPosition(board) {
    const pieces = readPieces(board);
    const history = getSanHistory();

    let wk = 0, bk = 0;
    for (const p of pieces.values()) {
      if (p === 'K') wk++;
      if (p === 'k') bk++;
    }
    if (wk !== 1 || bk !== 1) return null;

    let wMoved = false, bMoved = false;
    history.forEach((san, i) => {
      if (san[0] === 'K' || san.indexOf('O-O') === 0) {
        if (i % 2 === 0) wMoved = true;
        else bMoved = true;
      }
    });

    let rights = '';
    if (!wMoved && pieces.get('e1') === 'K') {
      if (pieces.get('h1') === 'R') rights += 'K';
      if (pieces.get('a1') === 'R') rights += 'Q';
    }
    if (!bMoved && pieces.get('e8') === 'k') {
      if (pieces.get('h8') === 'r') rights += 'k';
      if (pieces.get('a8') === 'r') rights += 'q';
    }

    let placement = '';
    for (let rank = 8; rank >= 1; rank--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = pieces.get(FILES[f] + rank);
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          placement += empty;
          empty = 0;
        }
        placement += p;
      }
      if (empty) placement += empty;
      if (rank > 1) placement += '/';
    }

    const turn = getTurn(history);
    const fullmove = Math.max(1, Math.floor(history.length / 2) + 1);
    const fen = `${placement} ${turn} ${rights || '-'} - 0 ${fullmove}`;
    return { fen, turn, flipped: isFlipped(board), pieces: pieces.size };
  }

  const canvas = document.createElement('canvas');
  canvas.id = 'cch-canvas';
  const ctx = canvas.getContext('2d');

  const bar = document.createElement('div');
  bar.id = 'cch-bar';
  const barFill = document.createElement('i');
  bar.appendChild(barFill);

  document.body.append(canvas, bar);

  function syncCanvas(board) {
    const r = board.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.left = r.left + 'px';
    canvas.style.top = r.top + 'px';
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    const wantW = Math.round(size * dpr), wantH = Math.round(size * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    return size;
  }

  function syncBar(board) {
    if (!CFG.showBar) {
      bar.style.display = 'none';
      return;
    }
    const r = board.getBoundingClientRect();
    bar.style.display = 'block';
    bar.style.left = (r.left - 22) + 'px';
    bar.style.top = r.top + 'px';
    bar.style.height = Math.min(r.width, r.height) + 'px';
  }

  function clearOverlay() {
    canvas.style.display = 'none';
    bar.style.display = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function sqXY(sq, flipped) {
    const f = sq.charCodeAt(0) - 97;
    const r = 8 - parseInt(sq[1], 10);
    return flipped ? [7 - f, 7 - r] : [f, r];
  }

  function arrow(from, to, flipped, size, color, alpha) {
    const [fx, fy] = sqXY(from, flipped);
    const [tx, ty] = sqXY(to, flipped);
    const s = size / 8;
    const x1 = (fx + 0.5) * s, y1 = (fy + 0.5) * s;
    const x2 = (tx + 0.5) * s, y2 = (ty + 0.5) * s;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(9, s * 0.34);
    const shaft = Math.max(4, s * 0.14);
    const bx = x2 - Math.cos(ang) * head;
    const by = y2 - Math.sin(ang) * head;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = shaft;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(bx - Math.sin(ang) * head * 0.55, by + Math.cos(ang) * head * 0.55);
    ctx.lineTo(bx + Math.sin(ang) * head * 0.55, by - Math.cos(ang) * head * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function evalToWhitePct(line) {
    if (!line) return 0.5;
    if (line.mate != null) return line.mate > 0 ? 1 : 0;
    if (line.score == null) return 0.5;
    return 1 / (1 + Math.pow(10, -line.score / 400));
  }

  function formatEval(line) {
    if (!line) return '–';
    if (line.mate != null) return 'M' + line.mate;
    if (line.score == null) return '–';
    const v = line.score / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function draw(board, flipped, showArrow) {
    const size = syncCanvas(board);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    if (showArrow) {
      const shown = lines.slice(0, Math.max(1, CFG.multiPV));
      const chosen = state.chosen;
      const ordered = shown.slice().sort((a, b) => {
        const am = a.pv && a.pv[0] === chosen ? 0 : 1;
        const bm = b.pv && b.pv[0] === chosen ? 0 : 1;
        return am - bm;
      });
      ordered.forEach((line, i) => {
        const mv = line.pv && line.pv[0];
        if (!mv) return;
        arrow(mv.slice(0, 2), mv.slice(2, 4), flipped, size,
          i === 0 ? '#7fe07f' : '#4f9f4f',
          i === 0 ? 0.92 : 0.42);
      });
    }

    canvas.style.display = 'block';
    syncBar(board);
    barFill.style.height = (evalToWhitePct(lines[0]) * 100).toFixed(1) + '%';
  }

  const hud = document.createElement('div');
  hud.id = 'cch-hud';
  hud.innerHTML = `
    <div class="hd"><span>CHESS HELPER</span><span class="v" data-status>…</span></div>
    <div class="bd">
      <div class="row"><span class="k">eval</span><span class="v" data-eval>–</span></div>
      <div class="row"><span class="k">best</span><span class="v best" data-best>–</span></div>
      <div class="row"><span class="k">line</span><span class="v" data-line>–</span></div>
      <div class="row"><span class="k">match</span><span class="v warn" data-match>–</span></div>
      <div class="row"><span class="k">depth</span><span class="v" data-depth>${CFG.depth}</span></div>
      <div class="btns">
        <button data-act="toggle">On/Off</button>
        <button data-act="reveal">Now</button>
        <button data-act="plus">+d</button>
      </div>
      <div class="btns">
        <button data-act="auto">Auto</button>
        <button data-act="human">Human</button>
      </div>
    </div>
  `;
  document.body.appendChild(hud);

  const elStatus = hud.querySelector('[data-status]');
  const elEval = hud.querySelector('[data-eval]');
  const elBest = hud.querySelector('[data-best]');
  const elLine = hud.querySelector('[data-line]');
  const elMatch = hud.querySelector('[data-match]');
  const elDepth = hud.querySelector('[data-depth]');
  const btnToggle = hud.querySelector('[data-act="toggle"]');
  const btnAuto = hud.querySelector('[data-act="auto"]');
  const btnHuman = hud.querySelector('[data-act="human"]');

  function renderHud() {
    const map = {
      idle: ['v', 'idle'],
      loading: ['v', 'loading'],
      ready: ['v', 'ready'],
      failed: ['v err', 'failed'],
    };
    const [cls, text] = map[engineState];
    elStatus.className = cls;
    elStatus.textContent = text;
    elDepth.textContent = CFG.depth;
    btnToggle.classList.toggle('on', CFG.enabled);
    btnAuto.classList.toggle('on', CFG.autoMove);
    btnHuman.classList.toggle('on', CFG.humanize);
    elEval.textContent = formatEval(lines[0]);
    elBest.textContent = state.chosen ? state.chosen.slice(0, 2) + '→' + state.chosen.slice(2, 4) : '–';
    elLine.textContent = state.chosenIdx ? '#' + (state.chosenIdx + 1) : '–';
    elMatch.textContent = stats.seen ? Math.round((stats.top / stats.seen) * 100) + '%' : '–';
  }

  hud.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'toggle') {
      CFG.enabled = !CFG.enabled;
      if (CFG.enabled) loadEngine();
      else {
        lines = [];
        clearOverlay();
      }
    } else if (act === 'reveal') {
      state.revealAt = 0;
    } else if (act === 'plus') {
      CFG.depth = CFG.depth >= 24 ? 6 : CFG.depth + 3;
      if (state.fen) analyze(state.fen);
    } else if (act === 'auto') {
      CFG.autoMove = !CFG.autoMove;
      if (CFG.autoMove) CFG.humanize = true;
    } else if (act === 'human') {
      CFG.humanize = !CFG.humanize;
    }
    save();
    renderHud();
  });

  hud.querySelector('.hd').addEventListener('click', () => hud.classList.toggle('min'));

  (() => {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    hud.querySelector('.hd').addEventListener('pointerdown', (e) => {
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = hud.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      hud.style.right = 'auto';
      hud.style.left = ox + 'px';
      hud.style.top = oy + 'px';
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      hud.style.left = (ox + e.clientX - sx) + 'px';
      hud.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('pointerup', () => {
      dragging = false;
    });
  })();

  const state = {
    fen: null,
    board: null,
    revealAt: 0,
    autoAt: 0,
    chosen: null,
    chosenIdx: 0,
    autoFen: null,
  };

  const stats = { seen: 0, top: 0 };

  function resetStats() {
    stats.seen = 0;
    stats.top = 0;
  }

  function computeDelay(pieceCount) {
    if (!CFG.humanize) return 0;
    const lo = Math.min(CFG.delayMin, CFG.delayMax);
    const hi = Math.max(CFG.delayMin, CFG.delayMax);
    let d = rand(lo, hi);
    if (pieceCount > 26) d *= 1.25;
    else if (pieceCount < 12) d *= 0.7;
    return d;
  }

  function chooseLine() {
    const n = Math.min(lines.length, Math.max(1, CFG.multiPV));
    if (!CFG.humanize || n <= 1) return 0;

    const top = lines[0];
    const cand = [];
    for (let i = 1; i < n; i++) {
      const l = lines[i];
      if (!l || !l.pv || !l.pv[0]) continue;
      if (top.mate != null || l.mate != null) {
        if (top.mate != null && l.mate != null && Math.abs(top.mate - l.mate) <= 1) cand.push(i);
      } else if (top.score != null && l.score != null) {
        if (Math.abs(top.score - l.score) <= CFG.threshold) cand.push(i);
      }
    }

    if (cand.length && Math.random() < CFG.secondBias) {
      return cand[Math.floor(Math.random() * cand.length)];
    }
    return 0;
  }

  function sqClass(sq) {
    const f = sq.charCodeAt(0) - 96;
    const r = 9 - parseInt(sq[1], 10);
    return 'square-' + f + r;
  }

  
  function fireAt(board, sq, type) {
    const r = board.getBoundingClientRect();
    const [x, y] = sqXY(sq, isFlipped(board));
    const s = Math.min(r.width, r.height) / 8;
    const cx = r.left + (x + 0.5) * s;
    const cy = r.top + (y + 0.5) * s;

    if (CFG.eventStyle === 'mouse') {
      board.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        button: 0, buttons: type === 'pointerdown' ? 1 : 0, view: window,
      }));
      return;
    }

    board.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerdown' ? 1 : 0, view: window,
    }));
  }

  async function playMove(board, uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];

    fireAt(board, from, 'pointerdown');
    await sleep(rand(40, 110));
    fireAt(board, from, 'pointerup');
    await sleep(rand(70, 180));
    fireAt(board, to, 'pointerdown');
    await sleep(rand(40, 110));
    fireAt(board, to, 'pointerup');

    if (promo) {
      await sleep(rand(220, 400));
      const pieces = Array.from(document.querySelectorAll('.promotion-piece'));
      const target = pieces.find((p) => p.classList.contains(ourColor(board) + promo));
      if (target) target.click();
    }
  }

  function tick() {
    if (!CFG.enabled) return;
    if (engineState === 'idle') loadEngine();

    const board = findBoard();
    if (!board) {
      state.fen = null;
      clearOverlay();
      return;
    }

    if (board !== state.board) {
      state.board = board;
      state.fen = null;
      state.chosen = null;
      lines = [];
      resetStats();
    }

    const pos = readPosition(board);
    if (!pos) return;

    if (pos.fen !== state.fen) {
      state.fen = pos.fen;
      state.chosen = null;
      state.chosenIdx = 0;
      state.autoFen = null;
      lines = [];
      state.revealAt = Date.now() + computeDelay(pos.pieces);
      state.autoAt = state.revealAt + rand(250, 1500);
      if (getSanHistory().length === 0) resetStats();
      analyze(pos.fen);
    }

    const mine = pos.turn === ourColor(board);

    if (!state.chosen && lines.length && lines[0] && lines[0].pv && lines[0].pv[0] && Date.now() >= state.revealAt) {
      const idx = chooseLine();
      const line = lines[idx];
      if (line && line.pv && line.pv[0]) {
        state.chosenIdx = idx;
        state.chosen = line.pv[0];
        stats.seen++;
        if (idx === 0) stats.top++;
      }
    }

    if (CFG.autoMove && state.chosen && mine && state.autoFen !== pos.fen && Date.now() >= state.autoAt) {
      state.autoFen = pos.fen;
      playMove(board, state.chosen);
    }

    draw(board, pos.flipped, CFG.arrow && (!CFG.onlyOurTurn || mine));
    renderHud();
  }

  setInterval(tick, TICK_MS);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      CFG.enabled = !CFG.enabled;
      save();
      if (CFG.enabled) loadEngine();
      else {
        lines = [];
        clearOverlay();
      }
      renderHud();
    }
  });

  GM_registerMenuCommand('Toggle helper (Alt+H)', () => {
    CFG.enabled = !CFG.enabled;
    save();
    renderHud();
  });

  GM_registerMenuCommand('Toggle humanizer', () => {
    CFG.humanize = !CFG.humanize;
    save();
    renderHud();
  });

  GM_registerMenuCommand('Toggle auto-move', () => {
    CFG.autoMove = !CFG.autoMove;
    save();
    renderHud();
  });

  GM_registerMenuCommand('Toggle arrow', () => {
    CFG.arrow = !CFG.arrow;
    save();
  });

  GM_registerMenuCommand('Toggle eval bar', () => {
    CFG.showBar = !CFG.showBar;
    save();
    if (!CFG.showBar) bar.style.display = 'none';
  });

  GM_registerMenuCommand('Toggle arrow on opponent turn', () => {
    CFG.onlyOurTurn = !CFG.onlyOurTurn;
    save();
  });

  GM_registerMenuCommand('Delay: slow / normal / fast', () => {
    const opts = [[1800, 7000], [900, 4200], [400, 1800]];
    const cur = opts.findIndex((o) => o[0] === CFG.delayMin);
    const next = opts[(cur + 1) % opts.length];
    CFG.delayMin = next[0];
    CFG.delayMax = next[1];
    save();
  });

  GM_registerMenuCommand('Second-line bias: 15 / 35 / 55%', () => {
    CFG.secondBias = CFG.secondBias >= 0.55 ? 0.15 : CFG.secondBias + 0.2;
    save();
  });

  GM_registerMenuCommand('Event style: pointer / mouse', () => {
    CFG.eventStyle = CFG.eventStyle === 'pointer' ? 'mouse' : 'pointer';
    save();
  });

  renderHud();
  if (CFG.enabled) loadEngine();
})();
