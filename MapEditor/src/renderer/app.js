/* Deceit Map Editor - OpenUnderground
 * Plain vanilla JS (no React/Babel/CDN) so the packaged .exe renders fully offline.
 * File dialogs come from the main process over IPC; file read/write uses Node 'fs'.
 */
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

// ---- Model constants -------------------------------------------------------
const LEVELS = 9;           // DECEIT.DNG holds 9 levels
const TILES_PER_CELL = 11;  // each cell -> 11x11 checkerboard floor tiles in the engine
const DEFAULT_W = 8;        // legacy Deceit level width
const DEFAULT_H = 8;        // legacy Deceit level height
const MIN_DIM = 2;
const MAX_DIM = 128;        // arbitrary dimensions are allowed (gameplay > legacy format)
function clampDim(n) { n = parseInt(n, 10); if (!Number.isFinite(n)) return DEFAULT_W; return Math.max(MIN_DIM, Math.min(MAX_DIM, n)); }

const CELL = { EMPTY: 0, FLOOR: 1, WALL: 2 };
const DIRS = ['N', 'E', 'S', 'W'];
const DIR_LABEL = { N: 'North', E: 'East', S: 'South', W: 'West' };
function emptyExits() { return { N: null, E: null, S: null, W: null }; }
function exitDirs(b) { return DIRS.filter(d => b.exits && b.exits[d] != null); }
// Remove every directional reference (on any border) that points at border id `gone`.
function unlinkReferences(lv, gone) {
  lv.wrapBorders.forEach(b => DIRS.forEach(d => { if (b.exits[d] === gone) b.exits[d] = null; }));
}

// Level 1 of the original Deceit dungeon (high nibble of each DECEIT.DNG byte).
// Used so the editor shows a real map on first launch without opening a file.
const LEVEL_1_DEFAULT = [
  0xF,0xF,0xF,0x0,0xF,0xF,0xF,0x0,
  0xF,0x1,0x0,0x0,0xC,0x0,0xF,0x0,
  0xF,0x0,0xF,0xF,0xF,0x0,0xF,0x0,
  0x0,0x0,0xF,0xD,0x0,0x0,0xF,0x0,
  0xF,0xC,0xF,0x0,0xF,0xF,0xF,0xF,
  0xF,0x0,0x0,0x0,0xF,0x2,0x0,0x9,
  0xF,0xF,0xF,0xF,0xF,0x0,0xF,0x0,
  0x0,0x0,0x0,0x0,0xF,0x9,0x0,0x0
];

// ---- State -----------------------------------------------------------------
function blankLevel(w = DEFAULT_W, h = DEFAULT_H) {
  w = clampDim(w); h = clampDim(h);
  return { width: w, height: h, cells: new Array(w * h).fill(CELL.EMPTY), fountains: [], spawn: null, wrapBorders: [], nextBorderId: 1, stairs: [], nextStairId: 1 };
}

function defaultLevels() {
  const lv = [];
  for (let i = 0; i < LEVELS; i++) lv.push(blankLevel());
  // Seed level 1 from the original Deceit layout so something shows immediately.
  for (let i = 0; i < DEFAULT_W * DEFAULT_H; i++) {
    lv[0].cells[i] = LEVEL_1_DEFAULT[i] !== 0x0 ? CELL.FLOOR : CELL.WALL;
  }
  return lv;
}

const state = {
  levels: defaultLevels(),
  level: 0,
  tool: 'floor',
  loadedDir: null,   // directory of the last opened/saved file (for the .json sidecar)
  selected: null,    // selected cell index
  painting: false,   // true only while a pointer button is held down
  strokeCells: null, // Set of cells already painted in the current stroke (dedupe)
  status: 'Level 1 pre-loaded from the original Deceit dungeon. Resize the grid to draw larger layouts; paint with the palette on the left.'
};

const TOOLS = [
  { id: 'floor',    label: 'Floor',        hint: 'Walkable 11x11 gold/black checkerboard cell (no walls). Hold and drag to paint.' },
  { id: 'wall',     label: 'Wall',         hint: 'Solid grey-brick wall cell. Hold and drag to trace non-square rooms.' },
  { id: 'fountain', label: 'Fountain',     hint: 'Click a cell to place/remove a fountain (original Underworld fountain). Sits on floor.' },
  { id: 'spawn',    label: 'Spawn Point',  hint: 'Click a floor cell to set where the player starts a new game on this level. Only one per level — clicking a new cell moves it; clicking it again removes it. Sits on floor.' },
  { id: 'wrap',     label: 'Wrap Border',  hint: 'Click an edge cell to mark a seamless wrap border. Set a per-direction exit (N/E/S/W) on the right; the corridor loops through that edge continuously. At least one direction is required.' },
  { id: 'stair',    label: 'Staircase',    hint: 'Click a floor cell to place a staircase. On the right choose Up, Down or Exit — Up/Down stairs teleport the player to a target staircase you pick (any level); Exit leaves the dungeon. Sits on floor.' },
  { id: 'erase',    label: 'Erase',        hint: 'Hold and drag to clear cells back to empty (floor/wall/fountain/border/stair).' }
];

// point tools act on the initial press only (no drag-toggling)
const POINT_TOOLS = { fountain: true, spawn: true, wrap: true, stair: true };

// ---- Helpers ---------------------------------------------------------------
function curLevel() { return state.levels[state.level]; }
function xy(lv, idx) { return { x: idx % lv.width, y: Math.floor(idx / lv.width) }; }
function idxOf(lv, x, y) { return y * lv.width + x; }
function fountainAt(lv, idx) { return lv.fountains.indexOf(idx); }
function borderAt(lv, idx) { return lv.wrapBorders.find(b => b.index === idx) || null; }
function stairAt(lv, idx) { return lv.stairs.find(s => s.index === idx) || null; }
// Clear any Up/Down stair target (on any level) that points at level `lvIndex` stair id `goneId`.
function unlinkStairReferences(lvIndex, goneId) {
  state.levels.forEach(l => l.stairs.forEach(s => {
    if (s.targetLevel === lvIndex && s.targetId === goneId) { s.targetLevel = null; s.targetId = null; }
  }));
}
function removeStair(lv, s) {
  const lvIndex = state.levels.indexOf(lv);
  lv.stairs = lv.stairs.filter(o => o !== s);
  unlinkStairReferences(lvIndex, s.id);
}

function setStatus(msg) { state.status = msg; const el = document.getElementById('status'); if (el) el.textContent = msg; }

// Resize a level, preserving the top-left overlap. Cells/fountains/borders that
// fall outside the new bounds are dropped, and any links pointing at a dropped
// border are cleared so the map stays consistent.
function resizeLevel(lv, nw, nh) {
  nw = clampDim(nw); nh = clampDim(nh);
  const nc = new Array(nw * nh).fill(CELL.EMPTY);
  const cw = Math.min(nw, lv.width), ch = Math.min(nh, lv.height);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      nc[y * nw + x] = lv.cells[y * lv.width + x];
  const nf = [];
  lv.fountains.forEach(i => { const p = xy(lv, i); if (p.x < nw && p.y < nh) nf.push(p.y * nw + p.x); });
  const removed = [];
  const nb = [];
  lv.wrapBorders.forEach(b => {
    const p = xy(lv, b.index);
    if (p.x < nw && p.y < nh) { b.index = p.y * nw + p.x; nb.push(b); }
    else removed.push(b.id);
  });
  let ns = null;
  if (lv.spawn != null) { const p = xy(lv, lv.spawn); if (p.x < nw && p.y < nh) ns = p.y * nw + p.x; }
  const nst = [];
  const removedStairs = [];
  lv.stairs.forEach(s => {
    const p = xy(lv, s.index);
    if (p.x < nw && p.y < nh) { s.index = p.y * nw + p.x; nst.push(s); }
    else removedStairs.push(s.id);
  });
  const lvIndex = state.levels.indexOf(lv);
  lv.width = nw; lv.height = nh; lv.cells = nc; lv.fountains = nf; lv.spawn = ns; lv.wrapBorders = nb; lv.stairs = nst;
  removed.forEach(id => unlinkReferences(lv, id));
  removedStairs.forEach(id => unlinkStairReferences(lvIndex, id));
}

// ---- Painting --------------------------------------------------------------
// Mutates the model for a single cell. Returns true when the change affects
// cells/UI beyond `idx` (wrap-border links, inspector) and a full render is needed.
function applyTool(idx) {
  const lv = curLevel();
  let structural = false;
  switch (state.tool) {
    case 'floor':
      lv.cells[idx] = CELL.FLOOR;
      break;
    case 'wall':
      lv.cells[idx] = CELL.WALL;
      { const f = fountainAt(lv, idx); if (f >= 0) lv.fountains.splice(f, 1); } // wall can't hold a fountain
      if (lv.spawn === idx) { lv.spawn = null; structural = true; }           // wall can't hold a spawn
      { const s = stairAt(lv, idx); if (s) { removeStair(lv, s); structural = true; } } // wall can't hold a stair
      break;
    case 'fountain': {
      const f = fountainAt(lv, idx);
      if (f >= 0) { lv.fountains.splice(f, 1); }            // toggle off
      else {
        if (lv.cells[idx] !== CELL.FLOOR) lv.cells[idx] = CELL.FLOOR; // fountains stand on floor
        lv.fountains.push(idx);
      }
      break;
    }
    case 'spawn': {
      if (lv.spawn === idx) { lv.spawn = null; }              // toggle off
      else {
        if (lv.cells[idx] !== CELL.FLOOR) lv.cells[idx] = CELL.FLOOR; // spawn stands on floor
        lv.spawn = idx;
      }
      structural = true;                                     // redraw old + new spawn cell + legend
      break;
    }
    case 'wrap': {
      const existing = borderAt(lv, idx);
      if (existing) {                                       // toggle off + unlink anything pointing here
        unlinkReferences(lv, existing.id);
        lv.wrapBorders = lv.wrapBorders.filter(b => b.index !== idx);
      } else {
        lv.wrapBorders.push({ id: lv.nextBorderId++, index: idx, exits: emptyExits() });
      }
      structural = true;                                     // updates inspector + tags
      break;
    }
    case 'stair': {
      const existing = stairAt(lv, idx);
      if (existing) { removeStair(lv, existing); }           // toggle off + unlink refs pointing here
      else {
        if (lv.cells[idx] !== CELL.FLOOR) lv.cells[idx] = CELL.FLOOR; // stairs stand on floor
        lv.stairs.push({ id: lv.nextStairId++, index: idx, kind: 'down', targetLevel: null, targetId: null });
      }
      structural = true;                                     // updates inspector + legend
      break;
    }
    case 'erase': {
      lv.cells[idx] = CELL.EMPTY;
      const f = fountainAt(lv, idx); if (f >= 0) lv.fountains.splice(f, 1);
      if (lv.spawn === idx) { lv.spawn = null; structural = true; }
      const b = borderAt(lv, idx);
      if (b) {
        unlinkReferences(lv, b.id);
        lv.wrapBorders = lv.wrapBorders.filter(o => o.index !== idx);
        structural = true;                                   // a border (and maybe links) went away
      }
      const s = stairAt(lv, idx);
      if (s) { removeStair(lv, s); structural = true; }      // a stair (and maybe links) went away
      break;
    }
  }
  state.selected = idx;
  return structural;
}

// Apply the current tool to one cell during a pointer stroke, updating the DOM
// incrementally (no full re-render) so drag-painting stays fast.
function paintAt(idx, isDragEnter) {
  if (isDragEnter && POINT_TOOLS[state.tool]) return;        // point tools: press only
  if (state.strokeCells) {
    if (state.strokeCells.has(idx)) return;                  // already painted this cell this stroke
    state.strokeCells.add(idx);
  }
  const prev = state.selected;
  const structural = applyTool(idx);
  if (structural) { render(); return; }
  if (prev != null && prev !== idx) refreshCell(prev);       // move selection highlight
  refreshCell(idx);
}

function stopPaint() { state.painting = false; state.strokeCells = null; }

// ---- File I/O --------------------------------------------------------------
// Build the full level list from a DECEIT.map.json sidecar object (authoritative:
// carries arbitrary per-level dimensions, cells, fountains and directional borders).
function buildLevelsFromSidecar(json) {
  const src = Array.isArray(json.levels) ? json.levels : [];
  const levels = [];
  for (let i = 0; i < LEVELS; i++) {
    const jl = src.find(l => l.index === i) || src[i];
    if (jl && Array.isArray(jl.cells)) {
      const w = clampDim(jl.width || DEFAULT_W), h = clampDim(jl.height || DEFAULT_H);
      const lv = blankLevel(w, h);
      for (let k = 0; k < Math.min(jl.cells.length, w * h); k++) lv.cells[k] = jl.cells[k];
      (jl.fountains || []).forEach(f => lv.fountains.push(f.y * w + f.x));
      if (jl.spawn && Number.isFinite(jl.spawn.x) && Number.isFinite(jl.spawn.y) && jl.spawn.x < w && jl.spawn.y < h) lv.spawn = jl.spawn.y * w + jl.spawn.x;
      let maxId = 0;
      (jl.wrapBorders || []).forEach(b => {
        let exits;
        if (b.exits) { exits = emptyExits(); DIRS.forEach(d => { exits[d] = b.exits[d] ?? null; }); }
        else if (b.exit != null) { exits = { N: b.exit, E: b.exit, S: b.exit, W: b.exit }; } // legacy single-exit
        else { exits = emptyExits(); }
        lv.wrapBorders.push({ id: b.id, index: b.y * w + b.x, exits });
        if (b.id > maxId) maxId = b.id;
      });
      lv.nextBorderId = maxId + 1;
      let maxStairId = 0;
      (jl.stairs || []).forEach(s => {
        lv.stairs.push({
          id: s.id, index: s.y * w + s.x, kind: s.kind || 'down',
          targetLevel: Number.isFinite(s.targetLevel) ? s.targetLevel : null,
          targetId: Number.isFinite(s.targetId) ? s.targetId : null
        });
        if (s.id > maxStairId) maxStairId = s.id;
      });
      lv.nextStairId = maxStairId + 1;
      levels.push(lv);
    } else {
      levels.push(blankLevel());
    }
  }
  return levels;
}

async function loadDng() {
  const p = await ipcRenderer.invoke('dialog:openDng');
  if (!p) return;
  try {
    const buf = fs.readFileSync(p);
    if (buf.length < LEVELS * 512) { alert('Invalid DECEIT.DNG: file too small.'); return; }
    // Legacy DNG is a fixed 8x8-per-level format.
    let levels = [];
    for (let l = 0; l < LEVELS; l++) {
      const off = l * 512;
      const lv = blankLevel(DEFAULT_W, DEFAULT_H);
      for (let i = 0; i < DEFAULT_W * DEFAULT_H; i++) {
        const nibble = (buf[off + i] >> 4) & 0xF;
        lv.cells[i] = nibble !== 0x0 ? CELL.FLOOR : CELL.WALL;
      }
      levels.push(lv);
    }
    // A sidecar next to the .DNG is authoritative (arbitrary dims + fountains + borders).
    const dir = path.dirname(p);
    const sidecar = path.join(dir, 'DECEIT.map.json');
    let usedSidecar = false;
    if (fs.existsSync(sidecar)) {
      try { levels = buildLevelsFromSidecar(JSON.parse(fs.readFileSync(sidecar, 'utf8'))); usedSidecar = true; }
      catch (e) { console.warn('sidecar parse failed', e); }
    }
    state.levels = levels;
    state.loadedDir = dir;
    state.level = 0;
    state.selected = null;
    setStatus('Loaded ' + path.basename(p) + (usedSidecar ? ' + DECEIT.map.json' : '') + ' as starting point.');
    render();
  } catch (e) {
    alert('Failed to read file: ' + e.message);
  }
}

async function loadMap() {
  const p = await ipcRenderer.invoke('dialog:openMap');
  if (!p) return;
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    state.levels = buildLevelsFromSidecar(json);
    state.loadedDir = path.dirname(p);
    state.level = 0;
    state.selected = null;
    setStatus('Loaded ' + path.basename(p) + ' (arbitrary-size map).');
    render();
  } catch (e) {
    alert('Failed to read map: ' + e.message);
  }
}

// Legacy 8x8 DNG buffer. Only written when every level is 8x8; larger maps are
// carried by the sidecar (the engine reads DECEIT.map.json for those).
function buildDngBuffer() {
  const buf = Buffer.alloc(LEVELS * 512);
  for (let l = 0; l < LEVELS; l++) {
    const off = l * 512;
    const lv = state.levels[l];
    for (let i = 0; i < DEFAULT_W * DEFAULT_H; i++) {
      buf[off + i] = lv.cells[i] === CELL.FLOOR ? 0xF0 : 0x00;
    }
  }
  return buf;
}

function buildSidecar() {
  return {
    version: 2,
    tilesPerCell: TILES_PER_CELL,
    levels: state.levels.map((lv, index) => {
      const out = {
        index,
        width: lv.width,
        height: lv.height,
        cells: lv.cells.slice(),               // 0=empty 1=floor 2=wall (row-major)
        fountains: lv.fountains.map(i => xy(lv, i)),
        wrapBorders: lv.wrapBorders.map(b => ({ id: b.id, ...xy(lv, b.index), exits: { N: b.exits.N, E: b.exits.E, S: b.exits.S, W: b.exits.W } })),
        stairs: lv.stairs.map(s => {
          const o = { id: s.id, ...xy(lv, s.index), kind: s.kind };
          if (s.kind !== 'exit') { o.targetLevel = s.targetLevel; o.targetId = s.targetId; }
          return o;
        })
      };
      // Only emit spawn when one is painted; the engine treats an absent key as "no spawn".
      if (lv.spawn != null) out.spawn = xy(lv, lv.spawn);
      return out;
    })
  };
}

function bordersMissingExit() {
  const bad = [];
  state.levels.forEach((lv, li) => lv.wrapBorders.forEach(b => {
    if (exitDirs(b).length === 0) bad.push('L' + (li + 1) + ' W' + b.id);
  }));
  return bad;
}

// Up/Down stairs with no target staircase chosen do nothing in-game.
function stairsMissingTarget() {
  const bad = [];
  state.levels.forEach((lv, li) => lv.stairs.forEach(s => {
    if (s.kind !== 'exit' && (s.targetLevel == null || s.targetId == null)) bad.push('L' + (li + 1) + ' S' + s.id);
  }));
  return bad;
}

async function saveMap() {
  const bad = bordersMissingExit();
  if (bad.length) {
    const ok = confirm('These wrap borders have no exit direction set and will do nothing in-game:\n  ' +
      bad.join(', ') + '\n\nEach wrap border should define at least one direction. Save anyway?');
    if (!ok) return;
  }
  const badStairs = stairsMissingTarget();
  if (badStairs.length) {
    const ok = confirm('These Up/Down staircases have no target staircase chosen and will do nothing in-game:\n  ' +
      badStairs.join(', ') + '\n\nEach Up/Down stair should point at a target staircase (or be set to Exit). Save anyway?');
    if (!ok) return;
  }
  const p = await ipcRenderer.invoke('dialog:saveDng');
  if (!p) return;
  try {
    const dir = path.dirname(p);
    const sidecar = path.join(dir, 'DECEIT.map.json');
    fs.writeFileSync(sidecar, JSON.stringify(buildSidecar(), null, 2));

    const allLegacy = state.levels.every(lv => lv.width === DEFAULT_W && lv.height === DEFAULT_H);
    let dngNote;
    if (allLegacy) {
      fs.writeFileSync(p, buildDngBuffer());
      dngNote = '\u2022 ' + p + '\n';
    } else {
      dngNote = '(legacy DECEIT.DNG skipped \u2014 map exceeds 8\u00D78; the engine reads DECEIT.map.json)\n';
    }
    state.loadedDir = dir;
    setStatus('Saved DECEIT.map.json' + (allLegacy ? ' + DECEIT.DNG' : ' (sidecar only, arbitrary size)') + ' to ' + dir);
    alert('Saved:\n' + dngNote + '\u2022 ' + sidecar + '\n\nCopy these into Assets/StreamingAssets/ for the engine.');
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}

// ---- Cell rendering (incremental) ------------------------------------------
let cellNodes = [];  // idx -> the .cell DOM node for the current level
let cellPx = 64;     // current cell size in px (scales with grid dimensions)

function computeCellPx(lv) {
  const maxDim = Math.max(lv.width, lv.height);
  if (maxDim <= 8) return 64;
  if (maxDim <= 12) return 46;
  if (maxDim <= 18) return 34;
  if (maxDim <= 26) return 24;
  if (maxDim <= 40) return 16;
  if (maxDim <= 64) return 11;
  return 8;
}

function cellClass(lv, idx) {
  const t = lv.cells[idx];
  const cls = ['cell'];
  if (t === CELL.FLOOR) cls.push('cell-floor');
  else if (t === CELL.WALL) cls.push('cell-wall');
  else cls.push('cell-empty');
  if (lv.spawn === idx) cls.push('cell-spawn');
  if (borderAt(lv, idx)) cls.push('cell-border');
  if (stairAt(lv, idx)) cls.push('cell-stair');
  if (state.selected === idx) cls.push('selected');
  return cls.join(' ');
}

function fillCell(node, lv, idx) {
  node.className = cellClass(lv, idx);
  node.style.width = cellPx + 'px';
  node.style.height = cellPx + 'px';
  node.textContent = '';
  const b = borderAt(lv, idx);
  if (b) {
    const dirs = exitDirs(b);
    const tag = el('div', 'border-tag' + (dirs.length === 0 ? ' border-tag-warn' : ''),
      'W' + b.id + (dirs.length ? ' ' + dirs.join('') : ' !'));
    if (cellPx < 24) tag.style.fontSize = '7px';
    node.appendChild(tag);
  }
  if (fountainAt(lv, idx) >= 0) {
    const fm = el('div', 'fountain-mark', '\u26F2');
    fm.style.fontSize = Math.max(10, Math.round(cellPx * 0.5)) + 'px';
    node.appendChild(fm);
  }
  if (lv.spawn === idx) {
    const sm = el('div', 'spawn-mark', '\u2605');
    sm.style.fontSize = Math.max(10, Math.round(cellPx * 0.5)) + 'px';
    node.appendChild(sm);
  }
  const st = stairAt(lv, idx);
  if (st) {
    const glyph = st.kind === 'up' ? '▲' : st.kind === 'exit' ? '🚪' : '▼';
    const km = el('div', 'stair-mark', glyph);
    km.style.fontSize = Math.max(9, Math.round(cellPx * 0.44)) + 'px';
    node.appendChild(km);
  }
}

function refreshCell(idx) { const n = cellNodes[idx]; if (n) fillCell(n, curLevel(), idx); }

// ---- Pointer interaction (event delegation on the grid) --------------------
function onPointerDown(e) {
  const c = e.target.closest('.cell');
  if (!c) return;
  e.preventDefault();
  state.painting = true;
  state.strokeCells = new Set();
  paintAt(parseInt(c.dataset.idx, 10), false);
}

function onPointerOver(e) {
  if (!state.painting) return;
  const c = e.target.closest('.cell');
  if (!c) return;
  paintAt(parseInt(c.dataset.idx, 10), true);
}

// ---- Rendering (full rebuild; used on load/level/tool/border changes) -------
function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  cellNodes = [];

  // Header
  const header = el('div', 'header');
  header.appendChild(el('h1', null, 'Deceit Map Editor'));
  const hc = el('div', 'header-controls');
  hc.appendChild(button('Load DECEIT.DNG', 'btn', loadDng));
  hc.appendChild(button('Load Map (.json)', 'btn', loadMap));
  hc.appendChild(button('Save Map', 'btn btn-primary', saveMap));
  header.appendChild(hc);
  root.appendChild(header);

  // Body: palette | grid | inspector
  const body = el('div', 'content');

  // ---- Left palette
  const palette = el('div', 'palette');
  palette.appendChild(el('h2', null, 'Palette'));
  TOOLS.forEach(t => {
    const item = el('div', 'tool' + (state.tool === t.id ? ' active' : ''));
    item.appendChild(el('div', 'tool-swatch swatch-' + t.id));
    const info = el('div', 'tool-info');
    info.appendChild(el('div', 'tool-label', t.label));
    info.appendChild(el('div', 'tool-hint', t.hint));
    item.appendChild(info);
    item.onclick = () => { state.tool = t.id; render(); };
    palette.appendChild(item);
  });
  body.appendChild(palette);

  // ---- Center: level tabs + size bar + grid
  const main = el('div', 'main-area');
  const tabs = el('div', 'tabs');
  for (let i = 0; i < LEVELS; i++) {
    tabs.appendChild(button('Level ' + (i + 1), 'tab' + (state.level === i ? ' active' : ''),
      () => { state.level = i; state.selected = null; render(); }));
  }
  main.appendChild(tabs);

  const lv = curLevel();

  // Size bar (per-level resizable grid)
  const sizebar = el('div', 'sizebar');
  sizebar.appendChild(el('span', 'sizebar-label', 'Level ' + (state.level + 1) + ' size (cells):'));
  const wIn = document.createElement('input');
  wIn.type = 'number'; wIn.className = 'dim-input'; wIn.min = MIN_DIM; wIn.max = MAX_DIM; wIn.value = lv.width;
  const hIn = document.createElement('input');
  hIn.type = 'number'; hIn.className = 'dim-input'; hIn.min = MIN_DIM; hIn.max = MAX_DIM; hIn.value = lv.height;
  sizebar.appendChild(wIn);
  sizebar.appendChild(el('span', 'dim-x', '\u00D7'));
  sizebar.appendChild(hIn);
  sizebar.appendChild(button('Resize', 'btn btn-sm', () => {
    const nw = clampDim(wIn.value), nh = clampDim(hIn.value);
    resizeLevel(lv, nw, nh);
    state.selected = null;
    setStatus('Level ' + (state.level + 1) + ' resized to ' + nw + '\u00D7' + nh + ' (top-left content kept).');
    render();
  }));
  sizebar.appendChild(el('span', 'sizebar-note', 'current ' + lv.width + '\u00D7' + lv.height + '  \u00B7  max ' + MAX_DIM + '\u00D7' + MAX_DIM));
  main.appendChild(sizebar);

  const canvas = el('div', 'canvas');
  const grid = el('div', 'grid');
  cellPx = computeCellPx(lv);
  grid.style.gridTemplateColumns = 'repeat(' + lv.width + ', ' + cellPx + 'px)';
  grid.style.gridTemplateRows = 'repeat(' + lv.height + ', ' + cellPx + 'px)';
  const total = lv.width * lv.height;
  for (let idx = 0; idx < total; idx++) {
    const c = document.createElement('div');
    c.dataset.idx = idx;
    fillCell(c, lv, idx);
    cellNodes[idx] = c;
    grid.appendChild(c);
  }
  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('pointerover', onPointerOver);
  canvas.appendChild(grid);
  main.appendChild(canvas);
  main.appendChild(el('div', 'status', state.status)).id = 'status';
  body.appendChild(main);

  // ---- Right inspector
  const inspector = el('div', 'inspector');
  inspector.appendChild(el('h2', null, 'Wrap Borders \u2014 Level ' + (state.level + 1)));
  if (lv.wrapBorders.length === 0) {
    inspector.appendChild(el('div', 'muted', 'No wrap borders yet. Pick the Wrap Border tool and click edge cells. Each border needs at least one directional exit \u2014 the corridor wraps seamlessly when the player crosses that edge.'));
  } else {
    lv.wrapBorders.forEach(bd => {
      const p = xy(lv, bd.index);
      const hasExit = exitDirs(bd).length > 0;
      const row = el('div', 'border-row' + (hasExit ? '' : ' border-row-warn'));
      row.appendChild(el('div', 'border-id', 'W' + bd.id + '  (' + p.x + ',' + p.y + ')'));
      if (!hasExit) row.appendChild(el('div', 'warn-msg', '\u26A0 Needs at least one exit direction.'));
      DIRS.forEach(d => {
        const line = el('div', 'dir-line');
        line.appendChild(el('div', 'dir-label', DIR_LABEL[d]));
        const sel = document.createElement('select');
        sel.className = 'exit-select';
        const none = document.createElement('option'); none.value = ''; none.textContent = '(no exit)'; sel.appendChild(none);
        lv.wrapBorders.filter(o => o.id !== bd.id).forEach(o => {
          const op = document.createElement('option'); op.value = String(o.id);
          op.textContent = '\u2192 W' + o.id; sel.appendChild(op);
        });
        sel.value = bd.exits[d] != null ? String(bd.exits[d]) : '';
        sel.onchange = () => { bd.exits[d] = sel.value ? parseInt(sel.value, 10) : null; render(); };
        line.appendChild(sel);
        row.appendChild(line);
      });
      inspector.appendChild(row);
    });
  }

  // ---- Staircases section
  inspector.appendChild(el('h2', null, 'Staircases \u2014 Level ' + (state.level + 1)));
  if (lv.stairs.length === 0) {
    inspector.appendChild(el('div', 'muted', 'No staircases yet. Pick the Staircase tool and click a floor cell. Set each stair to Up, Down or Exit \u2014 Up/Down stairs teleport the player to the target staircase you choose (any level); Exit leaves the dungeon.'));
  } else {
    // Every stair that can be travelled TO (Up/Down on any level; Exit stairs are not destinations).
    const targets = [];
    state.levels.forEach((ol, oi) => ol.stairs.forEach(os => { if (os.kind !== 'exit') targets.push({ level: oi, stair: os }); }));
    lv.stairs.forEach(sd => {
      const p = xy(lv, sd.index);
      const needsTarget = sd.kind !== 'exit';
      const hasTarget = sd.targetLevel != null && sd.targetId != null;
      const row = el('div', 'border-row' + (needsTarget && !hasTarget ? ' border-row-warn' : ''));
      row.appendChild(el('div', 'border-id', 'S' + sd.id + '  (' + p.x + ',' + p.y + ')'));

      const kline = el('div', 'dir-line');
      kline.appendChild(el('div', 'dir-label', 'Kind'));
      const ksel = document.createElement('select');
      ksel.className = 'exit-select';
      [['down', 'Down \u25BC'], ['up', 'Up \u25B2'], ['exit', 'Exit dungeon']].forEach(([v, t]) => {
        const op = document.createElement('option'); op.value = v; op.textContent = t; ksel.appendChild(op);
      });
      ksel.value = sd.kind;
      ksel.onchange = () => { sd.kind = ksel.value; if (sd.kind === 'exit') { sd.targetLevel = null; sd.targetId = null; } render(); };
      kline.appendChild(ksel);
      row.appendChild(kline);

      if (needsTarget) {
        const tline = el('div', 'dir-line');
        tline.appendChild(el('div', 'dir-label', 'Target'));
        const tsel = document.createElement('select');
        tsel.className = 'exit-select';
        const none = document.createElement('option'); none.value = ''; none.textContent = '(choose staircase)'; tsel.appendChild(none);
        targets.forEach(({ level, stair }) => {
          if (level === state.level && stair.id === sd.id) return;   // a stair can't target itself
          const tp = xy(state.levels[level], stair.index);
          const op = document.createElement('option');
          op.value = level + ':' + stair.id;
          op.textContent = '\u2192 L' + (level + 1) + ' S' + stair.id + ' (' + tp.x + ',' + tp.y + ')';
          tsel.appendChild(op);
        });
        tsel.value = hasTarget ? (sd.targetLevel + ':' + sd.targetId) : '';
        tsel.onchange = () => {
          if (!tsel.value) { sd.targetLevel = null; sd.targetId = null; }
          else { const parts = tsel.value.split(':'); sd.targetLevel = parseInt(parts[0], 10); sd.targetId = parseInt(parts[1], 10); }
          render();
        };
        tline.appendChild(tsel);
        row.appendChild(tline);
        if (!hasTarget) row.appendChild(el('div', 'warn-msg', '\u26A0 Up/Down stairs need a target staircase.'));
      }
      inspector.appendChild(row);
    });
  }

  inspector.appendChild(el('h2', null, 'Legend'));
  const legend = el('div', 'legend');
  [['swatch-floor', 'Floor (checkerboard)'], ['swatch-wall', 'Wall (grey brick)'],
   ['swatch-fountain', 'Fountain'], ['swatch-spawn', 'Spawn point'], ['swatch-wrap', 'Wrap border'], ['swatch-stair', 'Staircase (up/down/exit)']].forEach(([sw, name]) => {
    const r = el('div', 'legend-row');
    r.appendChild(el('div', 'tool-swatch ' + sw));
    r.appendChild(el('div', null, name));
    legend.appendChild(r);
  });
  inspector.appendChild(legend);
  body.appendChild(inspector);

  root.appendChild(body);
}

// tiny DOM helpers
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function button(text, cls, onclick) { const b = el('button', cls, text); b.onclick = onclick; return b; }

// Stop painting on release anywhere - including releases outside the grid or the
// window - so the tool never keeps painting after the button is let go.
window.addEventListener('pointerup', stopPaint);
window.addEventListener('pointercancel', stopPaint);
window.addEventListener('blur', stopPaint);

window.addEventListener('DOMContentLoaded', render);
// In case the script runs after DOMContentLoaded already fired:
if (document.readyState !== 'loading') render();
