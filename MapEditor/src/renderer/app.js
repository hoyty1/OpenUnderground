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

// ---- Texture / object palettes ---------------------------------------------
// Every wall/floor texture the original game ships (decoded from W64.TR / F32.TR).
const WALL_TEX_COUNT = 210;   // wallMat[] length in the engine (DataLoader.wallTex.Count)
const FLOOR_TEX_COUNT = 52;   // floorMat[] length in the engine
// A couple of engine slots are overwritten pure black at load; flag them so the
// user knows those swatches render solid black in-game rather than picking junk.
const BLACK_WALL_TEX = 64;
const BLACK_FLOOR_TEX = 26;
// Per-level engine capacity for DISTINCT explicit textures (mirrors DeceitLoader:
// 48 wall submeshes = 1 default + 47 explicit; 10 floor submeshes = 2 checkerboard
// + 7 explicit + 1 ceiling). Exceeding these falls back to default/checkerboard.
const MAX_WALL_TEX = 47;
const MAX_FLOOR_TEX = 7;
// Cell height limits enforced in the zoom editor UI. Minimum 4 keeps ceilings above
// head height; the engine clamps 1..16 regardless of what the sidecar carries.
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 16;

// Curated decorative objects placeable like the original fountains. `type` is the
// EObjectType value (== OBJECTS.GR sprite index); the engine spawns it through the
// same CreateObjectOfType + AddToWorld path fountains use.
const DECOR_OBJECTS = [
  { type: 302, name: 'Fountain' },  { type: 303, name: 'Cauldron' },   { type: 298, name: 'Campfire' },
  { type: 343, name: 'Shrine' },    { type: 344, name: 'Table' },      { type: 348, name: 'Chair' },
  { type: 349, name: 'Chest' },     { type: 347, name: 'Barrel' },     { type: 352, name: 'Pillar' },
  { type: 357, name: 'Gravestone' },{ type: 215, name: 'Anvil' },      { type: 140, name: 'Urn' },
  { type: 192, name: 'Plant' },     { type: 184, name: 'Mushroom' },   { type: 145, name: 'Torch' },
  { type: 146, name: 'Candle' },    { type: 340, name: 'Med Boulder' },{ type: 341, name: 'Boulder' },
  { type: 342, name: 'Sm Boulder' },{ type: 218, name: 'Rubble' }
];
const DECOR_BY_TYPE = {}; DECOR_OBJECTS.forEach(o => { DECOR_BY_TYPE[o.type] = o.name; });

function pad3(n) { return String(n).padStart(3, '0'); }
function wallThumb(i) { return 'assets/textures/walls/wall_' + pad3(i) + '.png'; }
function floorThumb(i) { return 'assets/textures/floors/floor_' + pad3(i) + '.png'; }
function objThumb(t) { return 'assets/textures/objects/obj_' + pad3(t) + '.png'; }

// ---- State -----------------------------------------------------------------
function blankLevel(w = DEFAULT_W, h = DEFAULT_H) {
  w = clampDim(w); h = clampDim(h);
  return {
    width: w, height: h,
    cells: new Array(w * h).fill(CELL.EMPTY),
    wallTex: new Array(w * h).fill(-1),   // per-cell wall texture (0-209, -1 = engine default)
    floorTex: new Array(w * h).fill(-1),  // per-cell floor texture (0-51, -1 = gold/black checkerboard)
    ceilTex: null,                        // level-wide ceiling texture (0-51 floor index, null = engine default)
    objects: [],                          // decorative objects: { type, index }
    cellHeight: new Array(w * h).fill(0), // per-cell ceiling/wall height, 0 = engine default (16)
    subFloor: {},                         // sparse: cellIdx -> Array(121) floorMat idx (-1 = none), sub-row 0 = north
    subWall: {},                          // sparse: cellIdx -> Array(121) wallMat idx (-1 = none), sub-row 0 = north
    subSolid: {},                         // sparse: cellIdx -> Array(121) 0/1 (1 = interior wall/void), sub-row 0 = north
    subSolidTex: {},                      // sparse: cellIdx -> Array(121) wallMat idx (-1 = inherit level default wall), for structural walls
    // Per-level defaults (override the dungeon-wide defaults for this floor):
    defaultHeight: 0,                     // 0 = inherit dungeon default, else 4..16
    defaultWallTex: -2,                   // -2 = inherit dungeon default, -1 = engine default wall, 0..209 = texture
    defaultFloorTex: -2,                  // -2 = inherit dungeon default, -1 = checkerboard, 0..51 = texture
    fountains: [], spawn: null, wrapBorders: [], nextBorderId: 1, stairs: [], nextStairId: 1
  };
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
  // Dungeon-wide defaults; a floor (level) or a room (cell) may override each of these.
  mapDefaults: { height: 16, wallTex: -1, floorTex: -1 }, // height 4..16; wall/floorTex: -1 = engine default, 0..N = texture
  wallTexProps: {},  // dungeon-wide per-wall-texture properties, keyed by texIndex: { [tex]: { noRepeat: true } }
  level: 0,
  tool: 'floor',
  loadedDir: null,   // directory of the last opened/saved file (for the .json sidecar)
  selected: null,    // selected cell index
  painting: false,   // true only while a pointer button is held down
  strokeCells: null, // Set of cells already painted in the current stroke (dedupe)
  selWall: 0,        // currently selected wall texture index (Wall Texture tool)
  selFloor: 0,       // currently selected floor texture index (Floor Texture tool)
  selObject: DECOR_OBJECTS[0].type, // currently selected decorative object (Place Object tool)
  zoomCell: null,    // cell idx currently open in the sub-tile zoom editor (null = closed)
  zoomMode: 'floor', // 'floor' | 'wall' — which sub-layer the zoom editor paints
  zoomErase: false,  // when true, zoom painting clears the sub override (-1)
  zoomSolidTex: -1,  // wall texture for NEW structural walls: -1 = inherit floor default wall, 0..N = explicit
  zoomPainting: false, zoomStroke: null,
  status: 'Level 1 pre-loaded from the original Deceit dungeon. Resize the grid to draw larger layouts; paint with the palette on the left.'
};

// ---- Undo / redo history ---------------------------------------------------
// The undoable "document" is the map data only: every level plus the dungeon-wide
// defaults. UI state (current level, selected cell, open zoom modal, active tool)
// is deliberately excluded so undo never yanks the view around. History entries are
// JSON snapshots. A whole paint/drag stroke is coalesced into ONE entry (captured at
// stopPaint), and every discrete edit (pickers, defaults, resize, inspector, zoom)
// is captured at the end of render() by diffing against the last committed snapshot,
// so no per-callback instrumentation is required.
const MAX_UNDO = 80;
const undoStack = [];
const redoStack = [];
let _histBaseline = null;   // JSON of the last committed document
let _histSuspend = false;   // true while restoring, so render()'s capture is a no-op
function docSnapshotJSON() { return JSON.stringify({ levels: state.levels, mapDefaults: state.mapDefaults, wallTexProps: state.wallTexProps }); }
function recordHistory() {
  if (_histSuspend) return;
  if (state.painting || state.zoomPainting) return;   // mid-stroke: wait for stopPaint
  const cur = docSnapshotJSON();
  if (_histBaseline === null) { _histBaseline = cur; return; }  // first render establishes the baseline
  if (cur === _histBaseline) return;                  // nothing about the map changed
  undoStack.push(_histBaseline);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  _histBaseline = cur;
}
function historyReset() { undoStack.length = 0; redoStack.length = 0; _histBaseline = docSnapshotJSON(); }
function restoreDoc(jsonStr) {
  const d = JSON.parse(jsonStr);
  state.levels = d.levels;
  state.mapDefaults = d.mapDefaults;
  state.wallTexProps = d.wallTexProps || {};
  const lv = state.levels[state.level] || state.levels[0];
  const total = lv.width * lv.height;
  if (state.selected != null && state.selected >= total) state.selected = null;
  if (state.zoomCell != null && (state.zoomCell >= total || lv.cells[state.zoomCell] !== CELL.FLOOR)) { state.zoomCell = null; state._zoomEdges = null; }
}
function undo() {
  if (!undoStack.length) { setStatus('Nothing to undo.'); return; }
  redoStack.push(_histBaseline);
  _histBaseline = undoStack.pop();
  _histSuspend = true;
  restoreDoc(_histBaseline);
  state.status = 'Undo \u2014 ' + undoStack.length + ' step(s) left.';
  render();
  _histSuspend = false;
}
function redo() {
  if (!redoStack.length) { setStatus('Nothing to redo.'); return; }
  undoStack.push(_histBaseline);
  _histBaseline = redoStack.pop();
  _histSuspend = true;
  restoreDoc(_histBaseline);
  state.status = 'Redo \u2014 ' + redoStack.length + ' step(s) left.';
  render();
  _histSuspend = false;
}

const TOOLS = [
  { id: 'floor',    label: 'Floor',        hint: 'Walkable 11x11 gold/black checkerboard cell (no walls). Hold and drag to paint.' },
  { id: 'wall',     label: 'Wall',         hint: 'Solid grey-brick wall cell. Hold and drag to trace non-square rooms.' },
  { id: 'walltex',  label: 'Wall Texture', hint: 'Pick any of the 210 game wall textures below, then hold and drag over WALL cells to skin them. The wall face rendered toward a neighbouring floor uses this texture.' },
  { id: 'floortex', label: 'Floor Texture',hint: 'Pick any of the 52 game floor textures below, then hold and drag over FLOOR cells. A textured cell replaces the gold/black checkerboard for that cell.' },
  { id: 'detail',   label: 'Detail / Zoom',hint: 'Click a FLOOR cell to zoom into its 11×11 sub-grid. Paint individual floor and wall sub-textures, carve non-square rooms with the Walls (structure) mode, and set the cell height (4–16); the ceiling drops to match and soffits close the step down to taller neighbours.' },
  { id: 'ceiling',  label: 'Ceiling',      hint: 'Level-wide ceiling texture. Click a floor texture below to set the ceiling for the whole level, or choose None for the engine default.' },
  { id: 'object',   label: 'Place Object', hint: 'Pick a decorative object below, then click a floor cell to place/remove it (fountains, tables, braziers, boulders and more). Placed like the original fountains.' },
  { id: 'fountain', label: 'Fountain',     hint: 'Click a cell to place/remove a fountain (original Underworld fountain). Sits on floor.' },
  { id: 'spawn',    label: 'Spawn Point',  hint: 'Click a floor cell to set where the player starts a new game on this level. Only one per level — clicking a new cell moves it; clicking it again removes it. Sits on floor.' },
  { id: 'wrap',     label: 'Wrap Border',  hint: 'Click an edge cell to mark a seamless wrap border. Set a per-direction exit (N/E/S/W) on the right; the corridor loops through that edge continuously. At least one direction is required.' },
  { id: 'stair',    label: 'Staircase',    hint: 'Click a floor cell to place a staircase. On the right choose Up, Down or Exit and (for Up/Down) which wall the stairway sits on — the player walks into that one wall stairway to travel to the linked stair, stepping out of its stairway on arrival. Exit leaves the dungeon. Sits on floor.' },
  { id: 'erase',    label: 'Erase',        hint: 'Hold and drag to clear cells back to empty (floor/wall/textures/object/fountain/border/stair).' }
];

// point tools act on the initial press only (no drag-toggling)
const POINT_TOOLS = { fountain: true, spawn: true, wrap: true, stair: true, object: true, detail: true };
// tools whose left-palette shows a texture/object picker grid
const PICKER_TOOLS = { walltex: true, floortex: true, ceiling: true, object: true };

// ---- Helpers ---------------------------------------------------------------
function curLevel() { return state.levels[state.level]; }
function xy(lv, idx) { return { x: idx % lv.width, y: Math.floor(idx / lv.width) }; }
function idxOf(lv, x, y) { return y * lv.width + x; }
function fountainAt(lv, idx) { return lv.fountains.indexOf(idx); }
function objectAt(lv, idx) { return lv.objects.findIndex(o => o.index === idx); }
function objName(type) { return DECOR_BY_TYPE[type] || ('#' + type); }
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
  const nwt = new Array(nw * nh).fill(-1);
  const nft = new Array(nw * nh).fill(-1);
  const nch = new Array(nw * nh).fill(0);
  const nsf = {}, nsw = {}, nss = {}, nsst = {};
  const cw = Math.min(nw, lv.width), ch = Math.min(nh, lv.height);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const oi = y * lv.width + x, ni = y * nw + x;
      nc[ni] = lv.cells[oi];
      nwt[ni] = lv.wallTex[oi];
      nft[ni] = lv.floorTex[oi];
      nch[ni] = lv.cellHeight[oi];
      if (lv.subFloor[oi]) nsf[ni] = lv.subFloor[oi];
      if (lv.subWall[oi]) nsw[ni] = lv.subWall[oi];
      if (lv.subSolid[oi]) nss[ni] = lv.subSolid[oi];
      if (lv.subSolidTex[oi]) nsst[ni] = lv.subSolidTex[oi];
    }
  const nobj = [];
  lv.objects.forEach(o => { const p = xy(lv, o.index); if (p.x < nw && p.y < nh) nobj.push({ type: o.type, index: p.y * nw + p.x }); });
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
  lv.width = nw; lv.height = nh; lv.cells = nc; lv.wallTex = nwt; lv.floorTex = nft; lv.objects = nobj; lv.fountains = nf; lv.spawn = ns; lv.wrapBorders = nb; lv.stairs = nst;
  lv.cellHeight = nch; lv.subFloor = nsf; lv.subWall = nsw; lv.subSolid = nss; lv.subSolidTex = nsst;
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
      delete lv.subFloor[idx]; delete lv.subWall[idx]; delete lv.subSolid[idx]; delete lv.subSolidTex[idx]; lv.cellHeight[idx] = 0; // wall clears floor detail
      { const f = fountainAt(lv, idx); if (f >= 0) lv.fountains.splice(f, 1); } // wall can't hold a fountain
      { const o = objectAt(lv, idx); if (o >= 0) lv.objects.splice(o, 1); }     // wall can't hold an object
      if (lv.spawn === idx) { lv.spawn = null; structural = true; }           // wall can't hold a spawn
      { const s = stairAt(lv, idx); if (s) { removeStair(lv, s); structural = true; } } // wall can't hold a stair
      break;
    case 'walltex':
      if (lv.cells[idx] === CELL.WALL) lv.wallTex[idx] = state.selWall;
      break;
    case 'floortex':
      if (lv.cells[idx] === CELL.FLOOR) lv.floorTex[idx] = state.selFloor;
      break;
    case 'ceiling':
      break;                                                 // ceiling is level-wide; set via the picker
    case 'detail':
      if (lv.cells[idx] !== CELL.FLOOR) setStatus('Detail / Zoom works on floor cells \u2014 paint this cell as floor first.');
      else { state.zoomCell = idx; if (state.zoomMode !== 'wall' && state.zoomMode !== 'solid') state.zoomMode = 'floor'; }
      structural = true;                                     // (re)render to open the zoom modal
      break;
    case 'object': {
      const oi = objectAt(lv, idx);
      if (oi >= 0) { lv.objects.splice(oi, 1); }             // toggle off
      else {
        if (lv.cells[idx] !== CELL.FLOOR) lv.cells[idx] = CELL.FLOOR; // objects stand on floor
        lv.objects.push({ type: state.selObject, index: idx });
      }
      break;
    }
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
        lv.stairs.push({ id: lv.nextStairId++, index: idx, kind: 'down', side: defaultStairSide(lv, idx), targetLevel: null, targetId: null });
      }
      structural = true;                                     // updates inspector + legend
      break;
    }
    case 'erase': {
      lv.cells[idx] = CELL.EMPTY;
      lv.wallTex[idx] = -1; lv.floorTex[idx] = -1;
      delete lv.subFloor[idx]; delete lv.subWall[idx]; delete lv.subSolid[idx]; delete lv.subSolidTex[idx]; lv.cellHeight[idx] = 0;
      { const o = objectAt(lv, idx); if (o >= 0) lv.objects.splice(o, 1); }
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

function stopPaint() { state.painting = false; state.strokeCells = null; state.zoomPainting = false; state.zoomStroke = null; recordHistory(); }

// ---- File I/O --------------------------------------------------------------
// Build the full level list from a DECEIT.map.json sidecar object (authoritative:
// carries arbitrary per-level dimensions, cells, fountains and directional borders).
function buildLevelsFromSidecar(json) {
  const src = Array.isArray(json.levels) ? json.levels : [];
  const levels = [];
  // Dungeon-wide defaults (top-level; absent = engine defaults). height: 0/absent -> 16.
  state.mapDefaults = {
    height: (Number.isFinite(json.defaultHeight) && json.defaultHeight > 0) ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, json.defaultHeight)) : 16,
    wallTex: (Number.isFinite(json.defaultWallTex) && json.defaultWallTex > 0) ? json.defaultWallTex - 1 : -1,
    floorTex: (Number.isFinite(json.defaultFloorTex) && json.defaultFloorTex > 0) ? json.defaultFloorTex - 1 : -1
  };
  // Dungeon-wide per-wall-texture properties (sidecar array -> sparse object keyed by tex index).
  state.wallTexProps = {};
  if (Array.isArray(json.wallTexProps)) json.wallTexProps.forEach(p => {
    if (p && Number.isFinite(p.tex) && p.tex >= 0 && p.noRepeat) state.wallTexProps[p.tex] = { noRepeat: true };
  });
  for (let i = 0; i < LEVELS; i++) {
    const jl = src.find(l => l.index === i) || src[i];
    if (jl && Array.isArray(jl.cells)) {
      const w = clampDim(jl.width || DEFAULT_W), h = clampDim(jl.height || DEFAULT_H);
      const lv = blankLevel(w, h);
      for (let k = 0; k < Math.min(jl.cells.length, w * h); k++) lv.cells[k] = jl.cells[k];
      if (Array.isArray(jl.wallTex)) for (let k = 0; k < Math.min(jl.wallTex.length, w * h); k++) lv.wallTex[k] = jl.wallTex[k];
      if (Array.isArray(jl.floorTex)) for (let k = 0; k < Math.min(jl.floorTex.length, w * h); k++) lv.floorTex[k] = jl.floorTex[k];
      if (Array.isArray(jl.cellHeight)) for (let k = 0; k < Math.min(jl.cellHeight.length, w * h); k++) lv.cellHeight[k] = jl.cellHeight[k] || 0;
      // Per-floor default overrides (0/absent = inherit dungeon).
      lv.defaultHeight = (Number.isFinite(jl.defaultHeight) && jl.defaultHeight > 0) ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, jl.defaultHeight)) : 0;
      lv.defaultWallTex = decodeLevelDef(jl.defaultWallTex);
      lv.defaultFloorTex = decodeLevelDef(jl.defaultFloorTex);
      (jl.subtiles || []).forEach(st => {
        if (!st || !Number.isFinite(st.cell) || st.cell < 0 || st.cell >= w * h) return;
        const N = TILES_PER_CELL * TILES_PER_CELL;
        if (Array.isArray(st.floor) && st.floor.some(v => v >= 0)) { const a = new Array(N).fill(-1); for (let k = 0; k < Math.min(st.floor.length, N); k++) a[k] = st.floor[k]; lv.subFloor[st.cell] = a; }
        if (Array.isArray(st.wall) && st.wall.some(v => v >= 0)) { const a = new Array(N).fill(-1); for (let k = 0; k < Math.min(st.wall.length, N); k++) a[k] = st.wall[k]; lv.subWall[st.cell] = a; }
        if (Array.isArray(st.solid) && st.solid.some(v => v === 1)) { const a = new Array(N).fill(0); for (let k = 0; k < Math.min(st.solid.length, N); k++) a[k] = st.solid[k] === 1 ? 1 : 0; lv.subSolid[st.cell] = a; }
        if (Array.isArray(st.solidTex) && st.solidTex.some(v => v >= 0)) { const a = new Array(N).fill(-1); for (let k = 0; k < Math.min(st.solidTex.length, N); k++) a[k] = st.solidTex[k]; lv.subSolidTex[st.cell] = a; }
      });
      lv.ceilTex = (Number.isFinite(jl.ceilTex) && jl.ceilTex > 0) ? (jl.ceilTex - 1) : null; // sidecar ceilTex is 1-based (0 = engine default)
      (jl.objects || []).forEach(o => { if (o.x < w && o.y < h) lv.objects.push({ type: o.type, index: o.y * w + o.x }); });
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
          side: ['N','E','S','W'].includes(s.side) ? s.side : defaultStairSide(lv, s.y * w + s.x),
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
    historyReset();   // undo history does not span a freshly loaded map
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
    historyReset();   // undo history does not span a freshly loaded map
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
    version: 8,
    tilesPerCell: TILES_PER_CELL,
    // Dungeon-wide per-wall-texture properties; only textures with a set flag are emitted.
    wallTexProps: Object.keys(state.wallTexProps)
      .map(k => ({ tex: +k, noRepeat: !!(state.wallTexProps[k] && state.wallTexProps[k].noRepeat) }))
      .filter(p => p.noRepeat),
    // Dungeon-wide defaults (JsonUtility-safe; 0 = engine default). height: 0 = 16.
    defaultHeight: state.mapDefaults.height === 16 ? 0 : state.mapDefaults.height,
    defaultWallTex: state.mapDefaults.wallTex < 0 ? 0 : state.mapDefaults.wallTex + 1,
    defaultFloorTex: state.mapDefaults.floorTex < 0 ? 0 : state.mapDefaults.floorTex + 1,
    levels: state.levels.map((lv, index) => {
      const out = {
        index,
        width: lv.width,
        height: lv.height,
        cells: lv.cells.slice(),               // 0=empty 1=floor 2=wall (row-major)
        wallTex: lv.wallTex.slice(),           // per-cell wall texture (0-209, -1 = engine default)
        floorTex: lv.floorTex.slice(),         // per-cell floor texture (0-51, -1 = gold/black checkerboard)
        ceilTex: lv.ceilTex == null ? 0 : lv.ceilTex + 1,  // level-wide ceiling, 1-based (0 = engine default)
        defaultHeight: lv.defaultHeight,                   // per-floor ceiling height, 0 = inherit dungeon
        defaultWallTex: encodeLevelDef(lv.defaultWallTex), // per-floor default wall tex (0 = inherit, 1 = engine default, n = tex n-2)
        defaultFloorTex: encodeLevelDef(lv.defaultFloorTex),// per-floor default floor tex (0 = inherit, 1 = checkerboard, n = tex n-2)
        objects: lv.objects.map(o => ({ type: o.type, ...xy(lv, o.index) })),
        cellHeight: lv.cellHeight.slice(),     // per-cell height, 0 = default 16 (row-major, aligned to cells)
        subtiles: buildSubtiles(lv),           // sparse per-cell 11×11 floor/wall sub-texture overrides
        fountains: lv.fountains.map(i => xy(lv, i)),
        wrapBorders: lv.wrapBorders.map(b => ({ id: b.id, ...xy(lv, b.index), exits: { N: b.exits.N, E: b.exits.E, S: b.exits.S, W: b.exits.W } })),
        stairs: lv.stairs.map(s => {
          const o = { id: s.id, ...xy(lv, s.index), kind: s.kind };
          if (s.kind !== 'exit') { o.side = s.side || 'N'; o.targetLevel = s.targetLevel; o.targetId = s.targetId; }
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

// Levels whose distinct explicit textures exceed the engine's per-level submesh budget.
function texCapWarnings() {
  const bad = [];
  state.levels.forEach((lv, li) => {
    const w = new Set(), f = new Set();
    lv.wallTex.forEach(t => { if (t >= 0) w.add(t); });
    lv.floorTex.forEach(t => { if (t >= 0) f.add(t); });
    Object.values(lv.subWall).forEach(a => a.forEach(t => { if (t >= 0) w.add(t); }));   // sub-tile walls count too
    Object.values(lv.subFloor).forEach(a => a.forEach(t => { if (t >= 0) f.add(t); })); // sub-tile floors count too
    Object.values(lv.subSolidTex).forEach(a => a.forEach(t => { if (t >= 0) w.add(t); })); // structural-wall textures count too
    const lw = levelWallTex(lv); if (lw >= 0) w.add(lw);   // effective floor default wall occupies a slot
    const lf = levelFloorTex(lv); if (lf >= 0) f.add(lf);  // effective floor default floor occupies a slot
    if (w.size > MAX_WALL_TEX) bad.push('L' + (li + 1) + ': ' + w.size + ' distinct wall textures (max ' + MAX_WALL_TEX + ')');
    if (f.size > MAX_FLOOR_TEX) bad.push('L' + (li + 1) + ': ' + f.size + ' distinct floor textures (max ' + MAX_FLOOR_TEX + ')');
  });
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
  const badTex = texCapWarnings();
  if (badTex.length) {
    const ok = confirm('These levels exceed the engine per-level texture capacity; textures beyond the limit fall back to the default wall / gold-black checkerboard floor in-game:\n  ' +
      badTex.join('\n  ') + '\n\nSave anyway?');
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
  if ((lv.subFloor && (lv.subFloor[idx] || lv.subWall[idx])) || (lv.subSolid && lv.subSolid[idx]) || (lv.subSolidTex && lv.subSolidTex[idx]) || (lv.cellHeight && lv.cellHeight[idx] > 0)) cls.push('cell-detail');
  if (state.selected === idx) cls.push('selected');
  return cls.join(' ');
}

function fillCell(node, lv, idx) {
  node.className = cellClass(lv, idx);
  node.style.width = cellPx + 'px';
  node.style.height = cellPx + 'px';
  node.textContent = '';
  // Textured cells paint their texture image over the default checkerboard / brick.
  // Effective texture cascades cell -> level default -> dungeon default.
  const ewt = lv.cells[idx] === CELL.WALL ? cellWallTex(lv, idx) : -1;
  const eft = lv.cells[idx] === CELL.FLOOR ? cellFloorTex(lv, idx) : -1;
  if (ewt >= 0) {
    node.style.backgroundImage = 'url("' + wallThumb(ewt) + '")';
    node.style.backgroundSize = '100% 100%';
  } else if (eft >= 0) {
    node.style.backgroundImage = 'url("' + floorThumb(eft) + '")';
    node.style.backgroundSize = '100% 100%';
  } else {
    node.style.backgroundImage = '';
  }
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
  const oi = objectAt(lv, idx);
  if (oi >= 0) {
    const om = el('div', 'obj-mark');
    const img = document.createElement('img');
    img.src = objThumb(lv.objects[oi].type);
    img.alt = objName(lv.objects[oi].type);
    img.onerror = () => { om.textContent = '?'; };
    om.appendChild(img);
    om.title = objName(lv.objects[oi].type);
    node.appendChild(om);
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
    if (st.kind !== 'exit') km.title = 'Stairway on ' + (st.side || 'N') + ' wall';
    node.appendChild(km);
  }
}

function refreshCell(idx) { const n = cellNodes[idx]; if (n) fillCell(n, curLevel(), idx); }

// ---- Texture / object picker (left palette, shown for picker tools) ---------
function buildPicker() {
  const wrap = el('div', 'tex-picker');
  const tool = state.tool;
  if (tool === 'object') {
    wrap.appendChild(el('div', 'picker-head', 'Objects \u2014 click a floor cell to place/remove'));
    const grid = el('div', 'tex-grid obj-grid');
    DECOR_OBJECTS.forEach(o => {
      const sw = el('div', 'obj-swatch' + (state.selObject === o.type ? ' sel' : ''));
      const img = document.createElement('img');
      img.src = objThumb(o.type); img.alt = o.name;
      img.onerror = () => { img.style.visibility = 'hidden'; };
      sw.appendChild(img);
      sw.appendChild(el('div', 'obj-name', o.name));
      sw.title = o.name + ' (type ' + o.type + ')';
      sw.onclick = () => { state.selObject = o.type; render(); };
      grid.appendChild(sw);
    });
    wrap.appendChild(grid);
    return wrap;
  }
  const isWall = tool === 'walltex';
  const isCeiling = tool === 'ceiling';
  const count = isWall ? WALL_TEX_COUNT : FLOOR_TEX_COUNT;
  const thumb = isWall ? wallThumb : floorThumb;
  const black = isWall ? BLACK_WALL_TEX : BLACK_FLOOR_TEX;
  let head;
  if (isWall) head = 'Wall textures (' + count + ') \u2014 paint onto WALL cells';
  else if (isCeiling) head = 'Ceiling (level-wide) \u2014 click to set Level ' + (state.level + 1);
  else head = 'Floor textures (' + count + ') \u2014 paint onto FLOOR cells';
  wrap.appendChild(el('div', 'picker-head', head));
  const grid = el('div', 'tex-grid');
  if (isCeiling) {
    const none = el('div', 'tex-swatch tex-none' + (curLevel().ceilTex == null ? ' sel' : ''), 'None');
    none.title = 'Engine default ceiling';
    none.onclick = () => { curLevel().ceilTex = null; render(); };
    grid.appendChild(none);
  }
  for (let i = 0; i < count; i++) {
    let selected;
    if (isCeiling) selected = curLevel().ceilTex === i;
    else if (isWall) selected = state.selWall === i;
    else selected = state.selFloor === i;
    const sw = el('div', 'tex-swatch' + (selected ? ' sel' : '') + (i === black ? ' tex-black' : ''));
    const img = document.createElement('img');
    img.src = thumb(i); img.alt = 'texture ' + i;
    img.onerror = () => { sw.classList.add('tex-missing'); sw.textContent = String(i); };
    sw.appendChild(img);
    sw.title = 'Texture ' + i + (i === black ? ' (renders solid black in-game)' : '');
    sw.onclick = () => {
      if (isCeiling) curLevel().ceilTex = i;
      else if (isWall) state.selWall = i;
      else state.selFloor = i;
      render();
    };
    attachTexPreview(sw, thumb(i), (isWall ? 'Wall' : isCeiling ? 'Ceiling' : 'Floor') + ' texture ' + i);
    grid.appendChild(sw);
  }
  wrap.appendChild(grid);
  return wrap;
}

// ---- Defaults (dungeon / per-floor) inspector section ----------------------
// A modal texture picker used by the default controls. onPick receives -2 (inherit),
// -1 (engine default / checkerboard) or a texture index 0..N. opts: {allowInherit, allowNone, title}.
// Wall Texture Properties: a dungeon-wide editor for per-wall-texture flags. Currently a single
// "don't repeat vertically" flag (drives the engine's object-on-wall once-at-bottom rendering),
// but the panel is structured so more per-texture properties can be added later.
function hasWallTexProps(tex) { const p = state.wallTexProps[tex]; return !!(p && p.noRepeat); }
function openWallTexProps() {
  const ov = el('div', 'zoom-overlay');
  const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  const modal = el('div', 'zoom-modal wtp-modal');
  const head = el('div', 'zoom-head');
  head.appendChild(el('div', 'zoom-title', 'Wall texture properties'));
  head.appendChild(button('Close ✕', 'btn btn-sm', close));
  modal.appendChild(head);
  modal.appendChild(el('div', 'wtp-help', 'Click a wall texture, then set its properties. These apply dungeon-wide and are saved with the map. Flagged textures are marked ⛔.'));
  const layout = el('div', 'wtp-layout');
  const grid = el('div', 'tex-grid wtp-grid');
  const panel = el('div', 'wtp-panel');
  let sel = -1;

  function renderPanel() {
    panel.innerHTML = '';
    if (sel < 0) { panel.appendChild(el('div', 'wtp-panel-empty', 'Select a wall texture on the left to edit its properties.')); return; }
    const prev = el('div', 'wtp-preview');
    const img = document.createElement('img'); img.src = wallThumb(sel); img.alt = 'wall texture ' + sel;
    img.onerror = () => { prev.classList.add('tex-missing'); prev.textContent = String(sel); };
    prev.appendChild(img);
    panel.appendChild(prev);
    panel.appendChild(el('div', 'wtp-sel-label', 'Wall texture #' + sel));
    const row = el('label', 'wtp-prop');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = hasWallTexProps(sel);
    cb.onchange = () => {
      if (cb.checked) state.wallTexProps[sel] = { noRepeat: true };
      else delete state.wallTexProps[sel];
      const sw = grid.querySelector('[data-tex="' + sel + '"]');
      if (sw) sw.classList.toggle('wtp-flagged', cb.checked);
      recordHistory();
    };
    row.appendChild(cb);
    const txt = el('span', 'wtp-prop-text');
    txt.appendChild(el('span', 'wtp-prop-name', "Don't repeat vertically"));
    txt.appendChild(el('span', 'wtp-prop-desc', 'Draws this texture once across the bottom 4-unit segment of the wall (for gates, grates, levers and other baked-in fixtures) instead of tiling it up the full height.'));
    row.appendChild(txt);
    panel.appendChild(row);
  }

  for (let i = 0; i < WALL_TEX_COUNT; i++) {
    const s = el('div', 'tex-swatch' + (hasWallTexProps(i) ? ' wtp-flagged' : '') + (i === BLACK_WALL_TEX ? ' tex-black' : ''));
    s.setAttribute('data-tex', i);
    const img = document.createElement('img'); img.src = wallThumb(i); img.alt = 'wall texture ' + i;
    img.onerror = () => { s.classList.add('tex-missing'); s.textContent = String(i); };
    s.appendChild(img); s.title = 'Wall texture ' + i;
    s.onclick = () => {
      sel = i;
      grid.querySelectorAll('.tex-swatch.sel').forEach(e => e.classList.remove('sel'));
      s.classList.add('sel');
      renderPanel();
    };
    attachTexPreview(s, wallThumb(i), 'Wall texture ' + i);
    grid.appendChild(s);
  }
  layout.appendChild(grid);
  layout.appendChild(panel);
  modal.appendChild(layout);
  renderPanel();
  ov.appendChild(modal); document.body.appendChild(ov);
}

function openTexPicker(kind, current, onPick, opts) {
  opts = opts || {};
  const thumb = kind === 'wall' ? wallThumb : floorThumb;
  const count = kind === 'wall' ? WALL_TEX_COUNT : FLOOR_TEX_COUNT;
  const black = kind === 'wall' ? BLACK_WALL_TEX : BLACK_FLOOR_TEX;
  const ov = el('div', 'zoom-overlay');
  const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  const modal = el('div', 'zoom-modal tex-picker-modal');
  const head = el('div', 'zoom-head');
  head.appendChild(el('div', 'zoom-title', opts.title || 'Pick a texture'));
  head.appendChild(button('Close ✕', 'btn btn-sm', close));
  modal.appendChild(head);
  const grid = el('div', 'tex-grid');
  const pick = (v) => { close(); onPick(v); };
  if (opts.allowInherit) { const s = el('div', 'tex-swatch tex-none' + (current === -2 ? ' sel' : ''), 'Inherit'); s.title = 'Inherit the dungeon default'; s.onclick = () => pick(-2); grid.appendChild(s); }
  if (opts.allowNone) { const s = el('div', 'tex-swatch tex-none' + (current === -1 ? ' sel' : ''), opts.noneLabel || (kind === 'wall' ? 'Default' : 'Checker')); s.title = opts.noneTitle || (kind === 'wall' ? 'Engine default wall' : 'Gold/black checkerboard'); s.onclick = () => pick(-1); grid.appendChild(s); }
  for (let i = 0; i < count; i++) {
    const s = el('div', 'tex-swatch' + (current === i ? ' sel' : '') + (i === black ? ' tex-black' : ''));
    const img = document.createElement('img'); img.src = thumb(i); img.alt = 'texture ' + i;
    img.onerror = () => { s.classList.add('tex-missing'); s.textContent = String(i); };
    s.appendChild(img); s.title = 'Texture ' + i + (i === black ? ' (renders solid black in-game)' : '');
    s.onclick = () => pick(i);
    attachTexPreview(s, thumb(i), (kind === 'wall' ? 'Wall' : 'Floor') + ' texture ' + i);
    grid.appendChild(s);
  }
  modal.appendChild(grid);
  ov.appendChild(modal); document.body.appendChild(ov);
}
function texDefLabel(kind, v) {
  if (v === -2) return 'Inherit';
  if (v === -1) return kind === 'wall' ? 'Engine default' : 'Checkerboard';
  return 'Texture #' + v;
}
// One row: label + effective-texture swatch (click to change) + current-setting text + Change button.
function defTexRow(labelText, kind, cur, eff, onPick, opts) {
  const thumb = kind === 'wall' ? wallThumb : floorThumb;
  const row = el('div', 'def-row');
  row.appendChild(el('div', 'def-label', labelText));
  const sw = el('div', 'def-swatch');
  if (eff >= 0) { sw.style.backgroundImage = 'url("' + thumb(eff) + '")'; sw.style.backgroundSize = '100% 100%'; attachTexPreview(sw, thumb(eff), labelText + ' (effective)'); }
  else sw.classList.add('def-swatch-none');
  sw.title = 'Effective: ' + (eff >= 0 ? 'texture #' + eff : (kind === 'wall' ? 'engine default wall' : 'gold/black checkerboard')) + ' — click to change';
  sw.onclick = () => openTexPicker(kind, cur, onPick, opts);
  row.appendChild(sw);
  row.appendChild(el('div', 'def-cur', (opts && opts.noneLabel && cur === -1) ? opts.noneLabel : texDefLabel(kind, cur)));
  row.appendChild(button('Change', 'btn btn-xs', () => openTexPicker(kind, cur, onPick, opts)));
  return row;
}
// ---- Apply-defaults actions ------------------------------------------------
// "Apply" flattens the texture overrides *inside* a scope so everything there falls
// back to that scope's default. The dungeon->floor->room->sub-tile cascade then shows
// the default texture across the whole scope. Heights are never touched.
function applyRow(label, help, onClick) {
  const row = el('div', 'def-row def-apply-row');
  row.appendChild(button(label, 'btn btn-sm btn-apply', onClick));
  row.appendChild(el('div', 'def-cur muted', help));
  return row;
}
function applyDungeonDefaults() {
  if (!confirm('Apply the dungeon default wall & floor textures to EVERY floor and room in the dungeon?\n\nThis clears all per-floor and per-room texture overrides so everything shows the dungeon default. Heights are kept. (Undo reverts this.)')) return;
  state.levels.forEach(lv => {
    lv.defaultWallTex = -2; lv.defaultFloorTex = -2;                      // floors re-inherit dungeon default
    lv.wallTex.fill(-1); lv.floorTex.fill(-1);                           // rooms re-inherit
    lv.subWall = {}; lv.subFloor = {};                                   // drop hand-painted sub-tile textures
    Object.keys(lv.subSolidTex).forEach(k => lv.subSolidTex[k].fill(-1));// carved structural walls re-inherit
  });
  setStatus('Applied the dungeon default textures to every floor and room; all per-floor and per-room overrides cleared.');
  render();
}
function applyFloorDefaults(lv) {
  if (!confirm('Apply this floor\u2019s default wall & floor textures to every room on Level ' + (state.level + 1) + '?\n\nThis clears all per-room texture overrides on this floor so every room shows this floor\u2019s default. Heights are kept. (Undo reverts this.)')) return;
  lv.wallTex.fill(-1); lv.floorTex.fill(-1);
  lv.subWall = {}; lv.subFloor = {};
  Object.keys(lv.subSolidTex).forEach(k => lv.subSolidTex[k].fill(-1));
  setStatus('Applied Level ' + (state.level + 1) + '\u2019s default textures to every room on this floor; per-room overrides cleared.');
  render();
}
function applyRoomDefaults(lv, idx, p) {
  delete lv.subWall[idx]; delete lv.subFloor[idx];                       // drop hand-painted sub-tile textures
  if (lv.subSolidTex[idx]) lv.subSolidTex[idx].fill(-1);                 // carved structural walls re-inherit
  setStatus('Applied the room default textures to every sub-tile in cell (' + p.x + ',' + p.y + '); individual sub-tile textures cleared.');
  render();
}
function buildDefaultsSection(lv) {
  const sec = el('div', 'defaults-section');
  // ---- Dungeon-wide defaults
  sec.appendChild(el('h2', null, 'Dungeon Defaults'));
  sec.appendChild(el('div', 'muted', 'Baseline for the whole dungeon. Any floor or individual room can override each of these.'));
  const hrow = el('div', 'def-row');
  hrow.appendChild(el('div', 'def-label', 'Ceiling height'));
  const hIn = document.createElement('input'); hIn.type = 'number'; hIn.className = 'dim-input'; hIn.min = MIN_HEIGHT; hIn.max = MAX_HEIGHT; hIn.value = state.mapDefaults.height;
  hIn.onchange = () => { let v = parseInt(hIn.value, 10); if (!Number.isFinite(v)) v = MAX_HEIGHT; v = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, v)); state.mapDefaults.height = v; render(); };
  hrow.appendChild(hIn);
  hrow.appendChild(el('span', 'zoom-ctl-note', MIN_HEIGHT + '–' + MAX_HEIGHT));
  sec.appendChild(hrow);
  sec.appendChild(defTexRow('Wall texture', 'wall', state.mapDefaults.wallTex, state.mapDefaults.wallTex, v => { state.mapDefaults.wallTex = v; render(); }, { allowNone: true, title: 'Dungeon default wall texture' }));
  sec.appendChild(defTexRow('Floor texture', 'floor', state.mapDefaults.floorTex, state.mapDefaults.floorTex, v => { state.mapDefaults.floorTex = v; render(); }, { allowNone: true, title: 'Dungeon default floor texture' }));
  sec.appendChild(applyRow('Apply to entire dungeon', 'Reset every floor and room to these dungeon defaults (clears all per-floor & per-room texture overrides).', applyDungeonDefaults));
  // ---- Per-floor defaults (override the dungeon default for the current level)
  sec.appendChild(el('h2', null, 'Floor Defaults — Level ' + (state.level + 1)));
  sec.appendChild(el('div', 'muted', 'Override the dungeon defaults for this floor. Leave on Inherit / blank to use the dungeon default.'));
  const fhrow = el('div', 'def-row');
  fhrow.appendChild(el('div', 'def-label', 'Ceiling height'));
  const fhIn = document.createElement('input'); fhIn.type = 'number'; fhIn.className = 'dim-input'; fhIn.min = MIN_HEIGHT; fhIn.max = MAX_HEIGHT;
  fhIn.value = lv.defaultHeight > 0 ? lv.defaultHeight : '';
  fhIn.placeholder = 'inherit (' + state.mapDefaults.height + ')';
  fhIn.onchange = () => { let v = parseInt(fhIn.value, 10); if (!Number.isFinite(v)) { lv.defaultHeight = 0; } else { v = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, v)); lv.defaultHeight = (v === state.mapDefaults.height ? 0 : v); } render(); };
  fhrow.appendChild(fhIn);
  fhrow.appendChild(button('Inherit', 'btn btn-xs', () => { lv.defaultHeight = 0; render(); }));
  sec.appendChild(fhrow);
  sec.appendChild(defTexRow('Wall texture', 'wall', lv.defaultWallTex, levelWallTex(lv), v => { lv.defaultWallTex = v; render(); }, { allowInherit: true, allowNone: true, title: 'Floor default wall texture' }));
  sec.appendChild(defTexRow('Floor texture', 'floor', lv.defaultFloorTex, levelFloorTex(lv), v => { lv.defaultFloorTex = v; render(); }, { allowInherit: true, allowNone: true, title: 'Floor default floor texture' }));
  sec.appendChild(applyRow('Apply to all rooms on this floor', 'Reset every room on this floor to the floor defaults above (clears per-room texture overrides on this floor).', () => applyFloorDefaults(lv)));
  return sec;
}

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
  const undoBtn = button('\u21B6 Undo', 'btn', undo); undoBtn.disabled = undoStack.length === 0; undoBtn.title = 'Undo (Ctrl+Z)';
  const redoBtn = button('\u21B7 Redo', 'btn', redo); redoBtn.disabled = redoStack.length === 0; redoBtn.title = 'Redo (Ctrl+Y or Ctrl+Shift+Z)';
  hc.appendChild(undoBtn); hc.appendChild(redoBtn);
  hc.appendChild(button('Wall Texture Properties', 'btn', openWallTexProps));
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
  if (PICKER_TOOLS[state.tool]) palette.appendChild(buildPicker());
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
  inspector.appendChild(buildDefaultsSection(lv));
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
    inspector.appendChild(el('div', 'muted', 'No staircases yet. Pick the Staircase tool and click a floor cell. Set each stair to Up, Down or Exit \u2014 for Up/Down also pick the wall the stairway sits on and the target staircase; the player walks into that wall stairway to travel there and steps out of the linked stairway. Exit leaves the dungeon.'));
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
        const sline = el('div', 'dir-line');
        sline.appendChild(el('div', 'dir-label', 'Wall side'));
        const ssel = document.createElement('select');
        ssel.className = 'exit-select';
        [['N', 'North wall'], ['E', 'East wall'], ['S', 'South wall'], ['W', 'West wall']].forEach(([v, t]) => {
          const op = document.createElement('option'); op.value = v; op.textContent = t; ssel.appendChild(op);
        });
        ssel.value = sd.side || 'N';
        ssel.onchange = () => { sd.side = ssel.value; render(); };
        sline.appendChild(ssel);
        row.appendChild(sline);

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
  inspector.appendChild(el('div', 'muted', 'Textured cells show their texture image; placed objects show a small thumbnail. Use the Wall Texture, Floor Texture, Ceiling and Place Object tools on the left.'));
  body.appendChild(inspector);

  root.appendChild(body);

  // Sub-tile zoom modal (open only while a valid floor cell is selected via Detail / Zoom).
  if (state.zoomCell != null && curLevel().cells[state.zoomCell] === CELL.FLOOR) root.appendChild(buildZoomOverlay());
  else state.zoomCell = null;

  recordHistory();   // capture any discrete map edit that led to this rebuild
}

// ---- Sub-tile zoom editor --------------------------------------------------
// A cell is an 11x11 grid of engine tiles. The zoom editor lets you paint each
// tile's floor and wall face individually and set the cell's height/ceiling.
let subCellNodes = [];
function subGet(lv, map, idx, fill) { if (fill === undefined) fill = -1; let a = map[idx]; if (!a) { a = new Array(TILES_PER_CELL * TILES_PER_CELL).fill(fill); map[idx] = a; } return a; }
// ---- Cascade resolution (dungeon default -> per-floor default -> per-cell) ----
// Height: cell (cellHeight>0) -> level (defaultHeight>0) -> dungeon (mapDefaults.height).
function parentHeight(lv) { return lv.defaultHeight > 0 ? lv.defaultHeight : state.mapDefaults.height; }
function heightOf(lv, idx) { return lv.cellHeight[idx] > 0 ? lv.cellHeight[idx] : parentHeight(lv); }
// Effective default wall/floor texture for a floor (level), inheriting the dungeon default.
// Returns -1 = engine default (wall) / checkerboard (floor), or a texture index 0..N.
function levelWallTex(lv) { return lv.defaultWallTex === -2 ? state.mapDefaults.wallTex : lv.defaultWallTex; }
function levelFloorTex(lv) { return lv.defaultFloorTex === -2 ? state.mapDefaults.floorTex : lv.defaultFloorTex; }
// Effective per-cell wall/floor texture, inheriting the level (then dungeon) default.
function cellWallTex(lv, idx) { return lv.wallTex[idx] >= 0 ? lv.wallTex[idx] : levelWallTex(lv); }
function cellFloorTex(lv, idx) { return lv.floorTex[idx] >= 0 ? lv.floorTex[idx] : levelFloorTex(lv); }
// Sidecar encoding for per-level default textures (JsonUtility-safe; absent scalar = 0 = inherit dungeon):
//   -2 (inherit dungeon) -> 0, -1 (engine default / checkerboard) -> 1, texture n -> n+2.
function encodeLevelDef(v) { return v === -2 ? 0 : v === -1 ? 1 : v + 2; }
function decodeLevelDef(v) { if (!Number.isFinite(v) || v === 0) return -2; if (v === 1) return -1; return v - 2; }
// Which of the cell's four sides face a non-floor neighbour (i.e. render a wall in-game).
function solidEdges(lv, idx) {
  const p = xy(lv, idx);
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < lv.width && y < lv.height && lv.cells[y * lv.width + x] === CELL.FLOOR;
  return { N: !isFloor(p.x, p.y - 1), S: !isFloor(p.x, p.y + 1), W: !isFloor(p.x - 1, p.y), E: !isFloor(p.x + 1, p.y) };
}
// Default wall for a new stair's single stairway: first side that faces a solid neighbour
// (so the stairway has a wall face to sit on), preferring N, then E, S, W.
function defaultStairSide(lv, idx) {
  const e = solidEdges(lv, idx);
  return e.N ? 'N' : e.E ? 'E' : e.S ? 'S' : e.W ? 'W' : 'N';
}
// Serialise the sparse sub-texture maps into the sidecar's subtiles[] array.
function buildSubtiles(lv) {
  const keys = new Set();
  Object.keys(lv.subFloor).forEach(k => { if (lv.subFloor[k].some(v => v >= 0)) keys.add(+k); });
  Object.keys(lv.subWall).forEach(k => { if (lv.subWall[k].some(v => v >= 0)) keys.add(+k); });
  Object.keys(lv.subSolid).forEach(k => { if (lv.subSolid[k].some(v => v === 1)) keys.add(+k); });
  const N = TILES_PER_CELL * TILES_PER_CELL; const out = [];
  keys.forEach(cell => {
    const f = lv.subFloor[cell] ? lv.subFloor[cell].slice() : new Array(N).fill(-1);
    const w = lv.subWall[cell] ? lv.subWall[cell].slice() : new Array(N).fill(-1);
    const entry = { cell, floor: f, wall: w };
    if (lv.subSolid[cell] && lv.subSolid[cell].some(v => v === 1)) entry.solid = lv.subSolid[cell].slice();
    if (lv.subSolidTex[cell] && lv.subSolidTex[cell].some(v => v >= 0)) entry.solidTex = lv.subSolidTex[cell].slice();
    out.push(entry);
  });
  return out;
}
function fillSubCell(node, sr, sc) {
  const lv = curLevel(); const idx = state.zoomCell;
  const subIdx = sr * TILES_PER_CELL + sc;
  node.className = 'subcell'; node.textContent = ''; node.style.backgroundImage = '';
  node.dataset.sr = sr; node.dataset.sc = sc;
  const fArr = lv.subFloor[idx], wArr = lv.subWall[idx], solArr = lv.subSolid[idx];
  const isSolid = solArr && solArr[subIdx] === 1;
  const edges = state._zoomEdges || solidEdges(lv, idx);
  const wallBearing = (sr === 0 && edges.N) || (sr === TILES_PER_CELL - 1 && edges.S) || (sc === 0 && edges.W) || (sc === TILES_PER_CELL - 1 && edges.E);
  // A sub-tile carved solid renders as an interior wall in every mode so the room shape stays visible.
  // Show its effective wall texture (structural-wall texture, inheriting the level default).
  if (isSolid) {
    node.classList.add('subcell-solid');
    if (state.zoomMode === 'solid') node.classList.add('subcell-solid-active');
    const stx = lv.subSolidTex[idx];
    const wv = stx ? stx[subIdx] : -1;
    const eff = wv >= 0 ? wv : cellWallTex(lv, idx);
    if (eff >= 0) { node.style.backgroundImage = 'url("' + wallThumb(eff) + '")'; node.style.backgroundSize = '100% 100%'; }
    return;
  }
  if (state.zoomMode === 'wall') {
    const wv = wArr ? wArr[subIdx] : -1;
    if (wv >= 0) { node.style.backgroundImage = 'url("' + wallThumb(wv) + '")'; node.style.backgroundSize = '100% 100%'; }
    else if (wallBearing) node.classList.add('subcell-walldefault');
    else node.classList.add('subcell-dim');
  } else if (state.zoomMode === 'solid') {
    // Structure mode: show a dimmed floor so open vs solid is obvious; click to carve walls.
    const cft = cellFloorTex(lv, idx);
    if (cft >= 0) { node.style.backgroundImage = 'url("' + floorThumb(cft) + '")'; node.style.backgroundSize = '100% 100%'; }
    else node.classList.add((sr + sc) % 2 ? 'subcell-gold' : 'subcell-black');
    node.classList.add('subcell-open');
  } else {
    const fv = fArr ? fArr[subIdx] : -1;
    const cft = cellFloorTex(lv, idx);
    if (fv >= 0) { node.style.backgroundImage = 'url("' + floorThumb(fv) + '")'; node.style.backgroundSize = '100% 100%'; }
    else if (cft >= 0) { node.style.backgroundImage = 'url("' + floorThumb(cft) + '")'; node.style.backgroundSize = '100% 100%'; }
    else node.classList.add((sr + sc) % 2 ? 'subcell-gold' : 'subcell-black');
  }
  if (wallBearing) node.classList.add('subcell-edge');
}
function refreshSubCell(sr, sc) { const n = subCellNodes[sr * TILES_PER_CELL + sc]; if (n) fillSubCell(n, sr, sc); }
function paintSub(sr, sc) {
  const lv = curLevel(); const idx = state.zoomCell; const subIdx = sr * TILES_PER_CELL + sc;
  if (state.zoomMode === 'solid') {
    const a = subGet(lv, lv.subSolid, idx, 0);
    const tex = subGet(lv, lv.subSolidTex, idx, -1);
    if (state.zoomErase) { a[subIdx] = 0; tex[subIdx] = -1; }
    else { a[subIdx] = 1; tex[subIdx] = state.zoomSolidTex; }
    refreshSubCell(sr, sc);
    return;
  }
  const map = state.zoomMode === 'wall' ? lv.subWall : lv.subFloor;
  const a = subGet(lv, map, idx);
  a[subIdx] = state.zoomErase ? -1 : (state.zoomMode === 'wall' ? state.selWall : state.selFloor);
  refreshSubCell(sr, sc);
}
function onSubDown(e) {
  const c = e.target.closest('.subcell'); if (!c) return; e.preventDefault();
  state.zoomPainting = true; state.zoomStroke = new Set();
  const sr = +c.dataset.sr, sc = +c.dataset.sc; state.zoomStroke.add(sr * TILES_PER_CELL + sc); paintSub(sr, sc);
}
function onSubOver(e) {
  if (!state.zoomPainting) return;
  const c = e.target.closest('.subcell'); if (!c) return;
  const sr = +c.dataset.sr, sc = +c.dataset.sc, k = sr * TILES_PER_CELL + sc;
  if (state.zoomStroke.has(k)) return; state.zoomStroke.add(k); paintSub(sr, sc);
}
function closeZoom() {
  const lv = curLevel();
  [lv.subFloor, lv.subWall].forEach(map => Object.keys(map).forEach(k => { if (map[k].every(v => v < 0)) delete map[k]; }));
  Object.keys(lv.subSolid).forEach(k => { if (lv.subSolid[k].every(v => v !== 1)) delete lv.subSolid[k]; });
  Object.keys(lv.subSolidTex).forEach(k => { if (!lv.subSolid[k] || lv.subSolidTex[k].every(v => v < 0)) delete lv.subSolidTex[k]; });
  state.zoomCell = null; state._zoomEdges = null; state.zoomPainting = false; state.zoomStroke = null; render();
}
function buildZoomPicker() {
  const wrap = el('div', 'zoom-picker');
  if (state.zoomMode === 'solid') {
    const lv = curLevel(); const idx = state.zoomCell;
    wrap.appendChild(el('div', 'picker-head', 'Walls (structure) — carve the room shape'));
    const info = el('div', 'zoom-solid-info');
    info.appendChild(el('p', null, 'Click or drag across the grid to toggle sub-tiles between OPEN floor and SOLID wall. Carve away the corners/edges you don’t want and the cell becomes a non-square room.'));
    info.appendChild(el('p', null, 'New walls take the wall texture selected below — leave it on Inherit and they use this room’s default wall texture (set under “Room Defaults” above). Painting over an existing solid tile re-textures it; Erasing restores floor.'));
    wrap.appendChild(info);
    const eff = cellWallTex(lv, idx);
    wrap.appendChild(el('div', 'picker-head', 'Wall texture for new walls'));
    const grid = el('div', 'tex-grid');
    const inh = el('div', 'tex-swatch tex-none' + (state.zoomSolidTex === -1 ? ' sel' : ''), 'Inherit');
    inh.title = 'Use this room’s default wall texture (' + (eff >= 0 ? '#' + eff : 'engine default') + ')';
    inh.onclick = () => { state.zoomSolidTex = -1; state.zoomErase = false; render(); };
    grid.appendChild(inh);
    for (let i = 0; i < WALL_TEX_COUNT; i++) {
      const sw = el('div', 'tex-swatch' + (state.zoomSolidTex === i ? ' sel' : '') + (i === BLACK_WALL_TEX ? ' tex-black' : ''));
      const img = document.createElement('img'); img.src = wallThumb(i); img.alt = 'texture ' + i;
      img.onerror = () => { sw.classList.add('tex-missing'); sw.textContent = String(i); };
      sw.appendChild(img); sw.title = 'Texture ' + i + (i === BLACK_WALL_TEX ? ' (renders solid black in-game)' : '');
      sw.onclick = () => { state.zoomSolidTex = i; state.zoomErase = false; render(); };
      attachTexPreview(sw, wallThumb(i), 'Wall texture ' + i);
      grid.appendChild(sw);
    }
    wrap.appendChild(grid);
    return wrap;
  }
  const isWall = state.zoomMode === 'wall';
  const count = isWall ? WALL_TEX_COUNT : FLOOR_TEX_COUNT;
  const thumb = isWall ? wallThumb : floorThumb;
  const black = isWall ? BLACK_WALL_TEX : BLACK_FLOOR_TEX;
  wrap.appendChild(el('div', 'picker-head', (isWall ? 'Wall' : 'Floor') + ' textures (' + count + ') — click to select, then paint the grid'));
  const grid = el('div', 'tex-grid');
  for (let i = 0; i < count; i++) {
    const selected = isWall ? state.selWall === i : state.selFloor === i;
    const sw = el('div', 'tex-swatch' + (selected ? ' sel' : '') + (i === black ? ' tex-black' : ''));
    const img = document.createElement('img'); img.src = thumb(i); img.alt = 'texture ' + i;
    img.onerror = () => { sw.classList.add('tex-missing'); sw.textContent = String(i); };
    sw.appendChild(img); sw.title = 'Texture ' + i + (i === black ? ' (renders solid black in-game)' : '');
    sw.onclick = () => { if (isWall) state.selWall = i; else state.selFloor = i; state.zoomErase = false; render(); };
    attachTexPreview(sw, thumb(i), (isWall ? 'Wall' : 'Floor') + ' texture ' + i);
    grid.appendChild(sw);
  }
  wrap.appendChild(grid); return wrap;
}
// ---- Room (single-cell) defaults, shown inside the zoom modal ---------------
// A room = one map cell = the 11×11 sub-grid you are zoomed into. Setting a room
// default writes the per-cell wallTex/floorTex (−1 = inherit this floor’s default),
// clears every per-sub-tile override in the cell, and resets carved structural walls
// to inherit — so the whole room repaints to the chosen texture. The engine resolves
// dungeon → floor → room → per-tile at load, so new walls also pick up the room default.
function buildRoomDefaults(lv, idx, p) {
  const sec = el('div', 'defaults-section zoom-room-defaults');
  sec.appendChild(el('h2', null, 'Room Defaults — Cell (' + p.x + ', ' + p.y + ')'));
  sec.appendChild(el('div', 'muted', 'One wall / floor texture for this whole room. Applying repaints every wall and floor in this cell and clears any individual sub-tile textures painted here. Leave on Inherit to use this floor’s default.'));
  const wallCur = lv.wallTex[idx] >= 0 ? lv.wallTex[idx] : -1;
  sec.appendChild(defTexRow('Wall texture', 'wall', wallCur, cellWallTex(lv, idx), v => {
    lv.wallTex[idx] = v;                                        // −1 = inherit floor default, else texture n
    delete lv.subWall[idx];                                     // drop hand-painted wall faces in this room
    if (lv.subSolidTex[idx]) lv.subSolidTex[idx].fill(-1);      // carved structural walls re-inherit
    setStatus('Room (' + p.x + ',' + p.y + ') wall texture ' + (v >= 0 ? 'set to #' + v : 'reset to inherit this floor’s default') + '; every wall in the room updated.');
    render();
  }, { allowNone: true, noneLabel: 'Inherit', noneTitle: 'Inherit this floor’s default wall texture', title: 'Room wall texture (whole cell)' }));
  const floorCur = lv.floorTex[idx] >= 0 ? lv.floorTex[idx] : -1;
  sec.appendChild(defTexRow('Floor texture', 'floor', floorCur, cellFloorTex(lv, idx), v => {
    lv.floorTex[idx] = v;
    delete lv.subFloor[idx];                                    // drop hand-painted floor tiles in this room
    setStatus('Room (' + p.x + ',' + p.y + ') floor texture ' + (v >= 0 ? 'set to #' + v : 'reset to inherit this floor’s default') + '; every floor in the room updated.');
    render();
  }, { allowNone: true, noneLabel: 'Inherit', noneTitle: 'Inherit this floor’s default floor texture', title: 'Room floor texture (whole cell)' }));
  sec.appendChild(applyRow('Apply to this room', 'Repaint every sub-tile in this room to the room textures above (clears individually painted sub-tile textures).', () => applyRoomDefaults(lv, idx, p)));
  return sec;
}
function buildZoomOverlay() {
  const lv = curLevel(); const idx = state.zoomCell; const p = xy(lv, idx);
  state._zoomEdges = solidEdges(lv, idx); subCellNodes = [];
  const ov = el('div', 'zoom-overlay');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeZoom(); });
  const modal = el('div', 'zoom-modal');
  const head = el('div', 'zoom-head');
  head.appendChild(el('div', 'zoom-title', 'Cell (' + p.x + ', ' + p.y + ') — sub-tile detail'));
  head.appendChild(button('Close ✕', 'btn btn-sm', closeZoom));
  modal.appendChild(head);
  const ctl = el('div', 'zoom-controls');
  ctl.appendChild(el('span', 'zoom-ctl-label', 'Cell height:'));
  const hIn = document.createElement('input'); hIn.type = 'number'; hIn.className = 'dim-input'; hIn.min = MIN_HEIGHT; hIn.max = MAX_HEIGHT; hIn.value = heightOf(lv, idx);
  hIn.onchange = () => {
    let v = parseInt(hIn.value, 10); if (!Number.isFinite(v)) v = parentHeight(lv); v = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, v)); hIn.value = v;
    lv.cellHeight[idx] = (v === parentHeight(lv) ? 0 : v);
    setStatus('Cell (' + p.x + ',' + p.y + ') height set to ' + v + ' (ceiling matches; soffits close steps down to taller neighbours).');
    refreshCell(idx);
  };
  ctl.appendChild(hIn);
  ctl.appendChild(el('span', 'zoom-ctl-note', '4–16 (' + parentHeight(lv) + ' = this floor’s default; ceiling drops to match)'));
  modal.appendChild(ctl);
  modal.appendChild(buildRoomDefaults(lv, idx, p));
  const modes = el('div', 'zoom-modes');
  [['floor', 'Floor sub-textures'], ['wall', 'Wall sub-textures'], ['solid', 'Walls (structure)']].forEach(([m, lbl]) => {
    modes.appendChild(button(lbl, 'tab' + (state.zoomMode === m ? ' active' : ''), () => { state.zoomMode = m; render(); }));
  });
  modes.appendChild(button(state.zoomErase ? 'Erasing (click to paint)' : 'Painting (click to erase)', 'btn btn-sm' + (state.zoomErase ? ' btn-warn' : ''), () => { state.zoomErase = !state.zoomErase; render(); }));
  modal.appendChild(modes);
  const bodyWrap = el('div', 'zoom-body');
  bodyWrap.appendChild(buildZoomPicker());
  const grid = el('div', 'zoom-grid');
  grid.style.gridTemplateColumns = 'repeat(' + TILES_PER_CELL + ', 1fr)';
  for (let sr = 0; sr < TILES_PER_CELL; sr++) for (let sc = 0; sc < TILES_PER_CELL; sc++) {
    const cell = document.createElement('div');
    fillSubCell(cell, sr, sc); subCellNodes[sr * TILES_PER_CELL + sc] = cell; grid.appendChild(cell);
  }
  grid.addEventListener('pointerdown', onSubDown); grid.addEventListener('pointerover', onSubOver);
  bodyWrap.appendChild(grid); modal.appendChild(bodyWrap);
  modal.appendChild(el('div', 'zoom-hint', state.zoomMode === 'wall'
    ? 'Painting wall faces. Highlighted edge tiles face a solid neighbour and show their wall in-game; interior tiles only render if that side becomes a wall. Sub-painted faces override the cell-level Wall Texture.'
    : state.zoomMode === 'solid'
    ? 'Carving room structure. Click or drag to toggle sub-tiles between open floor and solid interior wall; use Erasing to restore floor. Solid tiles become full-height walls with automatic collision in-game, so you can shape L-rooms, alcoves and pillars. North is the top row, west the left column — matching the main map.'
    : 'Painting the floor. Each tile overrides the cell’s floor/checkerboard individually. North is the top row, west the left column — matching the main map.'));
  ov.appendChild(modal); return ov;
}

// tiny DOM helpers
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function button(text, cls, onclick) { const b = el('button', cls, text); b.onclick = onclick; return b; }

// Hover-to-enlarge texture preview: a single shared floating panel that follows the
// cursor and shows a magnified copy of the swatch currently under the pointer, so
// small wall/floor textures can be inspected without opening anything.
let _texPreviewEl = null;
function texPreviewEl() {
  if (!_texPreviewEl) { _texPreviewEl = el('div', 'tex-preview'); _texPreviewEl.style.display = 'none'; document.body.appendChild(_texPreviewEl); }
  return _texPreviewEl;
}
function attachTexPreview(swEl, imgSrc, label) {
  swEl.addEventListener('mouseenter', () => {
    const pv = texPreviewEl(); pv.innerHTML = '';
    const img = document.createElement('img'); img.src = imgSrc; img.alt = label || '';
    img.onerror = () => { img.style.display = 'none'; };
    pv.appendChild(img);
    if (label) pv.appendChild(el('div', 'tex-preview-label', label));
    pv.style.display = 'block';
  });
  swEl.addEventListener('mousemove', (e) => {
    const pv = texPreviewEl(); const pad = 18;
    let x = e.clientX + pad, y = e.clientY + pad;
    const w = pv.offsetWidth || 272, h = pv.offsetHeight || 300;
    if (x + w > window.innerWidth) x = e.clientX - pad - w;
    if (y + h > window.innerHeight) y = e.clientY - pad - h;
    pv.style.left = Math.max(4, x) + 'px'; pv.style.top = Math.max(4, y) + 'px';
  });
  swEl.addEventListener('mouseleave', () => { const pv = texPreviewEl(); pv.style.display = 'none'; });
}

// Stop painting on release anywhere - including releases outside the grid or the
// window - so the tool never keeps painting after the button is let go.
window.addEventListener('pointerup', stopPaint);
window.addEventListener('pointercancel', stopPaint);
window.addEventListener('blur', stopPaint);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.zoomCell != null) closeZoom(); });

// Standard Windows undo/redo hotkeys: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo.
// Ignored while typing in a form field so the native text undo keeps working there.
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (k === 'y' && !e.shiftKey) { e.preventDefault(); redo(); }
});

window.addEventListener('DOMContentLoaded', render);
// In case the script runs after DOMContentLoaded already fired:
if (document.readyState !== 'loading') render();
