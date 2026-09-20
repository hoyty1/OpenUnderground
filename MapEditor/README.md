# Deceit Map Editor

Visual map editor for OpenUnderground's Dungeon Deceit. Paint walkable dungeons with a
tool palette, load the original `DECEIT.DNG` as a starting point, and save a map the Unity
engine can read.

Built as a standalone Windows app (Electron). Plain vanilla JS with **no CDN and no build
step**, so it runs fully offline.

## Quick Start (Windows)

1. Download `MapEditor/dist/DeceitMapEditor-Windows-x64-v1.7.0.zip`
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
| **Ceiling** | Level-wide ceiling texture. Click a floor texture in the picker to set the ceiling for the whole level, or **None** for the engine default. |
| **Place Object** | Opens a picker of decorative objects (fountains, cauldrons, tables, chairs, chests, barrels, pillars, braziers, boulders, plants, and more). Pick one, then click a floor cell to place/remove it. Spawned in-game the same way as the original fountains. |
| **Fountain** | Click a cell to place/remove the original Underworld fountain (sits on floor). |
| **Spawn Point** | Click a floor cell to set where the player starts a new game on this level. One per level — clicking a new cell moves it; clicking it again removes it. |
| **Wrap Border** | Click an edge cell to mark a seamless wrap border. Set a per-direction exit (N/E/S/W) on the right; the corridor loops through that edge continuously. |
| **Staircase** | Click a floor cell to place a staircase, then choose Up, Down or Exit on the right. Up/Down teleport to a target staircase on any level; Exit leaves the dungeon. |
| **Erase** | Hold and drag to clear cells back to empty (floor/wall/textures/object/fountain/border/stair). |

Click a cell to paint; hold and drag to paint many (point tools — object, fountain, spawn, wrap, stair — act on the initial press only). Switch levels with the tabs across the top.

### Texture capacity (per level)

Every texture is selectable, but the engine has a per-level budget for **distinct** explicit
textures: **47 wall textures** and **7 floor textures** per level, plus the one level-wide
ceiling. Exceeding that budget makes the overflow cells fall back to the default wall / the
gold-black checkerboard, and **Save Map** warns you first. A few engine slots are overwritten
pure black at load (wall texture 64, floor texture 26); the picker flags these so you know they
render solid black in-game.

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
  "version": 3,
  "tilesPerCell": 11,
  "levels": [
    {
      "index": 0,
      "width": 8,
      "height": 8,
      "cells":    [0,1,2, ...],                     // 0=empty 1=floor 2=wall, row-major
      "wallTex":  [-1,-1,17, ...],                  // per-cell wall texture 0-209, -1 = engine default
      "floorTex": [-1,3,-1, ...],                   // per-cell floor texture 0-51, -1 = gold/black checkerboard
      "ceilTex":  0,                                // level-wide ceiling, 1-based (0 = engine default)
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
`ceilTex` is stored **1-based** (0 means “no explicit ceiling”). Older sidecars without
these keys still load — missing fields fall back to defaults.

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
