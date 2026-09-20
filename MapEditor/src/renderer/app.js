/* Deceit Map Editor - OpenUnderground
 * Plain vanilla JS (no React/Babel/CDN) so the packaged .exe renders fully offline.
 * File dialogs come from the main process over IPC; file read/write uses Node 'fs'.
 */
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

// ---- Model constants -------------------------------------------------------
const GRID = 8;              // 8x8 original U4 Deceit cells per level
const LEVELS = 9;           // DECEIT.DNG holds 9 levels
const TILES_PER_CELL = 11;  // each U4 cell -> 11x11 checkerboard floor tiles in the engine

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
function blankLevel() {
  return { cells: new Array(GRID * GRID).fill(CELL.EMPTY), fountains: [], wrapBorders: [], nextBorderId: 1 };
}

function defaultLevels() {
  const lv = [];
  for (let i = 0; i < LEVELS; i++) lv.push(blankLevel());
  // Seed level 1 from the original Deceit layout so something shows immediately.
  for (let i = 0; i < GRID * GRID; i++) {
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
  status: 'Level 1 pre-loaded from the original Deceit dungeon. Paint with the palette on the left.'
};

const TOOLS = [
  { id: 'floor',    label: 'Floor',        hint: 'Walkable 11x11 gold/black checkerboard cell (no walls). Hold and drag to paint.' },
  { id: 'wall',     label: 'Wall',         hint: 'Solid grey-brick wall cell. Hold and drag to trace non-square rooms.' },
  { id: 'fountain', label: 'Fountain',     hint: 'Click a cell to place/remove a fountain (original Underworld fountain). Sits on floor.' },
  { id: 'wrap',     label: 'Wrap Border',  hint: 'Click an edge cell to mark a wrap border. Set a per-direction exit (N/E/S/W) on the right; at least one is required.' },
  { id: 'erase',    label: 'Erase',        hint: 'Hold and drag to clear cells back to empty (floor/wall/fountain/border).' }
];

// point tools act on the initial press only (no drag-toggling)
const POINT_TOOLS = { fountain: true, wrap: true };

// ---- Helpers ---------------------------------------------------------------
function curLevel() { return state.levels[state.level]; }
function xy(idx) { return { x: idx % GRID, y: Math.floor(idx / GRID) }; }
function fountainAt(lv, idx) { return lv.fountains.indexOf(idx); }
function borderAt(lv, idx) { return lv.wrapBorders.find(b => b.index === idx) || null; }

function setStatus(msg) { state.status = msg; const el = document.getElementById('status'); if (el) el.textContent = msg; }

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
    case 'erase': {
      lv.cells[idx] = CELL.EMPTY;
      const f = fountainAt(lv, idx); if (f >= 0) lv.fountains.splice(f, 1);
      const b = borderAt(lv, idx);
      if (b) {
        unlinkReferences(lv, b.id);
        lv.wrapBorders = lv.wrapBorders.filter(o => o.index !== idx);
        structural = true;                                   // a border (and maybe links) went away
      }
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
async function loadDng() {
  const p = await ipcRenderer.invoke('dialog:openDng');
  if (!p) return;
  try {
    const buf = fs.readFileSync(p);
    if (buf.length < LEVELS * 512) { alert('Invalid DECEIT.DNG: file too small.'); return; }
    const levels = [];
    for (let l = 0; l < LEVELS; l++) {
      const off = l * 512;
      const lv = blankLevel();
      for (let i = 0; i < GRID * GRID; i++) {
        const nibble = (buf[off + i] >> 4) & 0xF;
        lv.cells[i] = nibble !== 0x0 ? CELL.FLOOR : CELL.WALL;
      }
      levels.push(lv);
    }
    // Merge a sidecar (fountains + wrap borders) if one sits next to the .DNG.
    const dir = path.dirname(p);
    const sidecar = path.join(dir, 'DECEIT.map.json');
    if (fs.existsSync(sidecar)) {
      try {
        const json = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        if (Array.isArray(json.levels)) {
          json.levels.forEach(jl => {
            const li = jl.index;
            if (li == null || !levels[li]) return;
            (jl.fountains || []).forEach(f => levels[li].fountains.push(f.y * GRID + f.x));
            let maxId = 0;
            (jl.wrapBorders || []).forEach(b => {
              // New format: b.exits {N,E,S,W}. Old format: single b.exit -> apply to all dirs.
              let exits;
              if (b.exits) { exits = emptyExits(); DIRS.forEach(d => { exits[d] = b.exits[d] ?? null; }); }
              else if (b.exit != null) { exits = { N: b.exit, E: b.exit, S: b.exit, W: b.exit }; }
              else { exits = emptyExits(); }
              levels[li].wrapBorders.push({ id: b.id, index: b.y * GRID + b.x, exits });
              if (b.id > maxId) maxId = b.id;
            });
            levels[li].nextBorderId = maxId + 1;
          });
        }
      } catch (e) { console.warn('sidecar parse failed', e); }
    }
    state.levels = levels;
    state.loadedDir = dir;
    state.level = 0;
    state.selected = null;
    setStatus('Loaded ' + path.basename(p) + (fs.existsSync(sidecar) ? ' + DECEIT.map.json' : '') + ' as starting point.');
    render();
  } catch (e) {
    alert('Failed to read file: ' + e.message);
  }
}

function buildDngBuffer() {
  const buf = Buffer.alloc(LEVELS * 512);
  for (let l = 0; l < LEVELS; l++) {
    const off = l * 512;
    for (let i = 0; i < GRID * GRID; i++) {
      // FLOOR -> passable (0xF0); WALL/EMPTY -> solid (0x00). Engine reads (byte>>4)&0xF.
      buf[off + i] = state.levels[l].cells[i] === CELL.FLOOR ? 0xF0 : 0x00;
    }
  }
  return buf;
}

function buildSidecar() {
  return {
    version: 1,
    grid: GRID,
    tilesPerCell: TILES_PER_CELL,
    levels: state.levels.map((lv, index) => ({
      index,
      width: GRID,
      height: GRID,
      cells: lv.cells.slice(),                 // 0=empty 1=floor 2=wall (row-major)
      fountains: lv.fountains.map(i => xy(i)),
      wrapBorders: lv.wrapBorders.map(b => ({ id: b.id, ...xy(b.index), exits: { N: b.exits.N, E: b.exits.E, S: b.exits.S, W: b.exits.W } }))
    }))
  };
}

function bordersMissingExit() {
  const bad = [];
  state.levels.forEach((lv, li) => lv.wrapBorders.forEach(b => {
    if (exitDirs(b).length === 0) bad.push('L' + (li + 1) + ' W' + b.id);
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
  const p = await ipcRenderer.invoke('dialog:saveDng');
  if (!p) return;
  try {
    fs.writeFileSync(p, buildDngBuffer());
    const dir = path.dirname(p);
    const sidecar = path.join(dir, 'DECEIT.map.json');
    fs.writeFileSync(sidecar, JSON.stringify(buildSidecar(), null, 2));
    state.loadedDir = dir;
    setStatus('Saved ' + path.basename(p) + ' + DECEIT.map.json to ' + dir);
    alert('Saved:\n\u2022 ' + p + '\n\u2022 ' + sidecar + '\n\nCopy DECEIT.DNG into Assets/StreamingAssets/ for the engine.');
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}

// ---- Cell rendering (incremental) ------------------------------------------
let cellNodes = [];  // idx -> the .cell DOM node for the current level

function cellClass(lv, idx) {
  const t = lv.cells[idx];
  const cls = ['cell'];
  if (t === CELL.FLOOR) cls.push('cell-floor');
  else if (t === CELL.WALL) cls.push('cell-wall');
  else cls.push('cell-empty');
  if (borderAt(lv, idx)) cls.push('cell-border');
  if (state.selected === idx) cls.push('selected');
  return cls.join(' ');
}

function fillCell(node, lv, idx) {
  node.className = cellClass(lv, idx);
  node.textContent = '';
  const b = borderAt(lv, idx);
  if (b) {
    const dirs = exitDirs(b);
    const tag = el('div', 'border-tag' + (dirs.length === 0 ? ' border-tag-warn' : ''),
      'W' + b.id + (dirs.length ? ' ' + dirs.join('') : ' !'));
    node.appendChild(tag);
  }
  if (fountainAt(lv, idx) >= 0) node.appendChild(el('div', 'fountain-mark', '\u26F2'));
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

  // ---- Center: level tabs + grid
  const main = el('div', 'main-area');
  const tabs = el('div', 'tabs');
  for (let i = 0; i < LEVELS; i++) {
    tabs.appendChild(button('Level ' + (i + 1), 'tab' + (state.level === i ? ' active' : ''),
      () => { state.level = i; state.selected = null; render(); }));
  }
  main.appendChild(tabs);

  const canvas = el('div', 'canvas');
  const grid = el('div', 'grid');
  const lv = curLevel();
  for (let idx = 0; idx < GRID * GRID; idx++) {
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
    inspector.appendChild(el('div', 'muted', 'No wrap borders yet. Pick the Wrap Border tool and click edge cells. Each border needs at least one directional exit \u2014 the player warps only when they leave the cell across that edge.'));
  } else {
    lv.wrapBorders.forEach(bd => {
      const p = xy(bd.index);
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

  inspector.appendChild(el('h2', null, 'Legend'));
  const legend = el('div', 'legend');
  [['swatch-floor', 'Floor (checkerboard)'], ['swatch-wall', 'Wall (grey brick)'],
   ['swatch-fountain', 'Fountain'], ['swatch-wrap', 'Wrap border']].forEach(([sw, name]) => {
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
