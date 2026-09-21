# Deceit Map Editor

Visual map editor for OpenUnderground's Dungeon Deceit. Paint walkable dungeons with a
tool palette, load the original `DECEIT.DNG` as a starting point, and save a map the Unity
engine can read.

Built as a standalone Windows app (Electron). Plain vanilla JS with **no CDN and no build
step**, so it runs fully offline.

## Quick Start (Windows)

1. Download `MapEditor/dist/DeceitMapEditor-Windows-x64-v1.14.0.zip`
2. Extract the ZIP
3. Run `Deceit Map Editor.exe`

Level 1 of the original Deceit dungeon is pre-loaded on launch, so you see a real map
immediately.

## Palette (left side)

| Tool | What it does |
|------|--------------|
| **Floor** | Paints a walkable cell rendered in-game as an 11×11 gold/black checkerboard (no walls). Hold and drag to paint many. |
| **Wall** | Paints a solid grey-brick wall cell. Hold and drag to trace rooms that aren't square. |
| **Wall Texture** | Opens a picker of **all 210 original wall textures** (decoded from `W64.TR`). Pick one, then hold and drag over WALL cells to skin them — the wall face rendered toward an adjacent floor uses that texture. |
| **Floor Texture** | Opens a picker of **all 52 original floor textures** (decoded from `F32.TR`). Pick one, then hold and drag over FLOOR cells; a textured cell replaces the gold/black checkerboard for that cell only. |
| **Detail / Zoom** | Click a FLOOR cell to open its **11×11 sub-grid** in a zoom modal. Paint individual floor tiles, individual wall faces, or use **Walls (structure)** to carve the cell into non-square room shapes, and set the **cell height (4–16)** — the ceiling drops to match and soffits close the step down to taller neighbours. See [Sub-tile detail & height](#sub-tile-detail--height) below. |
| **Ceiling** | Level-wide ceiling texture. Click a floor texture in the picker to set the ceiling for the whole level, or **None** for the engine default. |
| **Place Object** | Opens a picker of decorative objects (fountains, cauldrons, tables, chairs, chests, barrels, pillars, braziers, boulders, plants, and more). Pick one, then click a floor cell to place/remove it. Spawned in-game the same way as the original fountains. |
| **Fountain** | Click a cell to place/remove the original Underworld fountain (sits on floor). |
| **Spawn Point** | Click a floor cell to set where the player starts a new game on this level. One per level — clicking a new cell moves it; clicking it again removes it. |
| **Wrap Border** | Click an edge cell to mark a seamless wrap border. Set a per-direction exit (N/E/S/W) on the right; the corridor loops through that edge continuously. |
| **Staircase** | Click a floor cell to place a staircase, then choose Up, Down or Exit on the right. Up/Down teleport to a target staircase on any level; Exit leaves the dungeon. |
| **Erase** | Hold and drag to clear cells back to empty (floor/wall/textures/object/fountain/border/stair). |

Click a cell to paint; hold and drag to paint many (point tools — object, fountain, spawn, wrap, stair — act on the initial press only). Switch levels with the tabs across the top.

### Undo / redo

Every map edit is undoable with the standard Windows hotkeys: **Ctrl+Z** to undo and **Ctrl+Y** (or **Ctrl+Shift+Z**) to redo. The **↶ Undo** / **↷ Redo** buttons in the header do the same and grey out when there is nothing to undo/redo. A whole hold-and-drag stroke counts as **one** undo step, and every discrete change — texture pickers, dungeon/floor/room defaults, grid resize, wrap-border and staircase edits, and all sub-tile zoom painting — is captured too (up to 80 steps). Undo/redo change only the map, never the current level, selection or open zoom view, so the editor never jumps around under you. History is cleared when you load a different map. The hotkeys are ignored while you're typing in a number or dropdown field so those keep their native text-undo behaviour.

### Texture capacity (per level)

Every texture is selectable, but the engine has a per-level budget for **distinct** explicit
textures: **47 wall textures** and **7 floor textures** per level, plus the one level-wide
ceiling. Exceeding that budget makes the overflow cells fall back to the default wall / the
gold-black checkerboard, and **Save Map** warns you first. A few engine slots are overwritten
pure black at load (wall texture 64, floor texture 26); the picker flags these so you know they
render solid black in-game. **Hover any texture swatch** (in the palette pickers or the zoom
sub-texture pickers) to see a large 256×256 enlargement so you can tell similar textures apart.

## Dungeon & floor defaults

Ceiling height, wall texture and floor texture each resolve through a three-level **cascade**,
so you set a value once and override it only where it differs:

1. **Dungeon default** — the **Dungeon Defaults** panel at the top of the right inspector sets
   one height, wall texture and floor texture for the whole dungeon.
2. **Floor default** — the **Floor Defaults — Level N** panel overrides any of the three for the
   current level. Leave a value on **Inherit** to keep using the dungeon default.
3. **Room / cell** — inside the **Detail / Zoom** modal, the **Room Defaults — Cell (x, y)**
   panel sets one wall texture and one floor texture for that whole room. Applying a room default
   repaints every wall and floor in the cell and clears any individual sub-tile textures you had
   painted there; leave it on **Inherit** to keep using the floor default. Cell height and
   individual per-tile textures still override the room default, and each structural wall you draw
   can take its own wall texture. Anything left on Inherit falls through to the room default, then
   the floor default, then the dungeon default.

A newly drawn structural wall starts on **Inherit**, so it immediately shows the room's default
wall texture (which itself inherits the floor, then dungeon default); assign a specific texture
only where you want that wall to differ. The cascade is stored losslessly in the sidecar (an
inherited value is written as 0/-1, and a room default reuses the per-cell wallTex/floorTex
arrays), so re-editing a saved map keeps every default intact and older maps load unchanged.

### Apply defaults (flatten overrides)

Each defaults panel has an **Apply** button that pushes that scope's default *down* into
everything below it, clearing the finer overrides so the whole scope inherits cleanly:

- **Apply to entire dungeon** (Dungeon Defaults panel) — resets every floor and every room on
  every level back to the dungeon defaults: it clears all per-floor defaults, all per-cell wall/
  floor textures, and all sub-tile wall/floor painting across the whole dungeon. Prompts first.
- **Apply to all rooms on this floor** (Floor Defaults panel) — clears every per-cell and
  sub-tile texture override on the current level, so every room falls back to this floor's
  defaults (the floor default itself is kept). Prompts first.
- **Apply to this room** (Room Defaults panel in the zoom modal) — repaints every sub-tile in the
  cell to the room's wall/floor defaults, clearing any individually painted sub-tile textures
  (the room default itself is kept).

Apply only flattens texture overrides; it never changes heights, structural walls, objects,
fountains or stairs. Every Apply is a single undo step.

## Sub-tile detail & height

Each map cell is rendered in-game as an **11×11 grid of engine tiles**. The **Detail / Zoom**
tool exposes that grid so you can go finer than a whole cell:

- **Room Defaults** — at the top of the modal, set one **wall** and one **floor** texture for the
  entire room (this cell). Applying repaints every wall and floor in the cell at once and clears
  any per-sub-tile textures painted here, so it is the fast way to skin a whole room; leave either
  on **Inherit** to use this floor's default. It is also the base that newly carved walls inherit.

- **Floor sub-textures** — paint any of the 52 floor textures onto individual tiles inside the
  cell. Untouched tiles keep the cell's Floor Texture (or the gold/black checkerboard). The
  zoom grid matches the main map's orientation: **north is the top row, west is the left column**.
- **Wall sub-textures** — paint individual wall faces. Edge tiles that face a solid neighbour
  (highlighted with a blue outline) render their wall in-game and override the cell-level Wall
  Texture; interior tiles only render if that side later becomes a wall.
- **Object textures on walls** — some wall textures are objects mounted *on* a wall rather than a
  repeating surface (gates, grates, levers and other fixtures baked into the texture). Mark these
  with the **Wall Texture Properties** button in the header: click the texture and tick **Don't
  repeat vertically**. Then, wherever that texture is painted as a wall, the engine draws the
  object **once** across the bottom 4-unit segment of the wall and fills the rest of the wall's
  height with the room's default wall texture as a background, so the object never tiles upward.
  The flags are dungeon-wide and saved in the map (`DECEIT.map.json`, sidecar v7), so each map
  carries its own set — nothing is hardcoded. Paint the textures exactly like any other wall
  sub-texture; the once-at-the-bottom behaviour follows the flag automatically.
- **Walls (structure)** — carve the cell into non-square rooms. Paint sub-tiles **solid** (shown
  as brown brick) to turn them into full-height interior wall/void, or paint them back **open**.
  A solid sub-tile becomes an engine tile of type 0: it renders no floor, the open tiles around
  it draw full-height wall faces against it, and the mesh collider blocks it — so a single map
  cell can hold an L-shape, a diagonal, a pillar, or any other shape instead of a plain square.
  Each solid sub-tile carries its **own wall texture** — click a solid sub-tile with the picker
  to skin its structural wall face. A newly drawn wall starts out **Inherit**, meaning it uses
  the room's default wall texture (which itself inherits the floor, then dungeon default) until
  you assign a specific one. Solid sub-tiles stay visible in every zoom mode so the room outline is always
  clear. (You can also paint a **Wall sub-texture** on the open tile next to a solid area for the
  older per-face method; a hand-painted sub-texture still wins over the structural texture.)
- **Cell height (4–16)** — sets how tall the cell's walls are, and the **ceiling drops to match**.
  Where a shorter cell sits beside a taller one, a vertical **soffit** is emitted to close the
  ceiling step so there is no gap. 16 is the default full height (stored as 0 in the sidecar);
  very low values may clip the camera.

Sub-tile floor/wall textures count toward the same per-level texture budget as cell-level
textures (see below), so painting many distinct textures across sub-tiles can hit the cap faster —
**Save Map** warns you when a level exceeds it. Painting a cell back to **Wall** or **Erase**
clears its sub-tile detail and height. Cells carrying sub-tile detail or a custom height show a
small blue dot in the top-right corner on the main grid. Press **Esc** or click outside the modal
to close it.

## Stair-cell wall textures

The floor cell that holds a staircase **trigger** is skinned in-game with the matching stairway
wall texture on every wall face it renders: **wall texture 139 for an Up staircase** and **wall
texture 137 for a Down staircase** (Exit staircases get no special texture). This is applied
automatically at load — you only place the staircase and choose Up/Down/Exit as usual. For the
stairway to be visible the stair cell must sit against a solid neighbour so a wall face actually
exists there; a stair cell with open floor on all sides has no wall to paint. The stairway
texture is applied last, so it wins over neighbour-cell, structural and hand-painted wall
textures on that cell.

## Loading & saving

- **Load DECEIT.DNG** — imports all 9 levels as a starting point (open cells → Floor,
  solid cells → Wall). If a `DECEIT.map.json` sits next to the `.DNG`, its fountains and
  wrap borders are merged back in.
- **Save Map** — writes **two** files to the folder you choose:
  - `DECEIT.DNG` — floor/wall geometry the engine already reads (checkerboard floors +
    grey-brick walls). Copy this into `Assets/StreamingAssets/` to play it.
  - `DECEIT.map.json` — sidecar with fountains and wrap-border exits (consumed by the
    engine's Deceit loader).

## Map sidecar format (`DECEIT.map.json`)

```json
{
  "version": 6,
  "tilesPerCell": 11,
  "defaultHeight": 0,                                // dungeon-wide ceiling height 4-16 (0 = 16, classic full height)
  "defaultWallTex": 0,                               // dungeon-wide default wall, 1-based (0 = engine default wall)
  "defaultFloorTex": 0,                              // dungeon-wide default floor, 1-based (0 = gold/black checkerboard)
  "levels": [
    {
      "index": 0,
      "width": 8,
      "height": 8,
      "defaultHeight": 0,                           // per-floor height override: 0 = inherit dungeon, else 4-16
      "defaultWallTex": 0,                          // per-floor wall override: 0 = inherit dungeon, 1 = engine default, n>=2 = wallMat (n-2)
      "defaultFloorTex": 0,                         // per-floor floor override: 0 = inherit dungeon, 1 = checkerboard, n>=2 = floorMat (n-2)
      "cells":    [0,1,2, ...],                     // 0=empty 1=floor 2=wall, row-major
      "wallTex":  [-1,-1,17, ...],                  // per-cell wall texture 0-209, -1 = engine default
      "floorTex": [-1,3,-1, ...],                   // per-cell floor texture 0-51, -1 = gold/black checkerboard
      "ceilTex":  0,                                // level-wide ceiling, 1-based (0 = engine default)
      "cellHeight": [0,0,12, ...],                  // per-cell height 4-16, 0 = default (16); row-major, aligned to cells
      "subtiles": [                                 // sparse per-cell 11x11 sub-texture overrides
        {
          "cell": 17,                               // cell index (y*width + x), row-major
          "floor": [-1,-1,3, ...],                   // 121 entries, floor texture 0-51 or -1; sub-row 0 = north, sub-col 0 = west
          "wall":  [-1,17,-1, ...],                  // 121 entries, wall texture 0-209 or -1; same layout
          "solid": [0,0,1, ...],                     // 121 entries, 1 = carved interior wall/void, 0 = open floor; same layout (omitted when all 0)
          "solidTex": [-1,-1,17, ...]                // 121 entries, parallel to solid[]; wall texture 0-209 for that structural wall, -1 = inherit floor default wall (omitted when all -1)
        }
      ],
      "objects":  [ { "type": 302, "x": 4, "y": 4 } ], // decorative objects; type = OBJECTS.GR sprite index
      "fountains": [ { "x": 4, "y": 4 } ],
      "spawn": { "x": 2, "y": 2 },                  // omitted when no spawn is painted
      "wrapBorders": [
        { "id": 1, "x": 0, "y": 3, "exits": { "N": null, "E": null, "S": null, "W": true } }
      ],
      "stairs": [
        { "id": 1, "x": 5, "y": 5, "kind": "down", "targetLevel": 1, "targetId": 2 }
      ]
    }
  ]
}
```

`width`/`height` are stored per level so the format can grow beyond 8×8 later. `wallTex`
and `floorTex` are the full-resolution per-cell texture arrays (same length as `cells`);
`ceilTex` is stored **1-based** (0 means “no explicit ceiling”). `cellHeight` is a per-cell
array the same length as `cells` (0 = default full height of 16). `subtiles` is a **sparse**
list — only cells that actually have sub-tile overrides appear, each with full-length 121-entry
`floor`/`wall` arrays (sub-row 0 = north, sub-col 0 = west, matching the engine's tile flip). The
optional `solid` array (same 121-entry layout) carves non-square rooms: a `1` marks a sub-tile as
full-height interior wall/void (engine tile type 0). The parallel `solidTex` array skins each
structural wall (`-1` = inherit the floor default wall). The top-level and per-level
`defaultHeight` / `defaultWallTex` / `defaultFloorTex` fields carry the defaults cascade (see
[Dungeon & floor defaults](#dungeon--floor-defaults)). Older sidecars without these keys still
load — missing fields fall back to defaults.

## Run from source

```bash
cd MapEditor
npm install
npm start
```

## Notes

- The full wall/floor texture set and the decorative objects are baked into the app as
  thumbnails decoded straight from the original game data (`W64.TR`, `F32.TR`, `OBJECTS.GR`),
  so the swatches match what the engine renders. A handful of object thumbnails are
  OBJECTS.GR placeholders, but they still place correctly and render through the in-game 3D
  model.
- Objects and fountains currently populate the **starting level only** (they are spawned
  from the new-game hook, mirroring the original fountain behaviour). Placing them across
  levels reachable by staircase is a planned follow-up.
- The Windows `.exe` is packaged manually (Wine-based electron-builder is unavailable in
  the build environment); only the `.zip` is tracked in git, not the unpacked folder.
