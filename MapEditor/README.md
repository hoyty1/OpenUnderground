# Deceit Map Editor

Visual map editor for OpenUnderground's Dungeon Deceit. Paint walkable dungeons with a
tool palette, load the original `DECEIT.DNG` as a starting point, and save a map the Unity
engine can read.

Built as a standalone Windows app (Electron). Plain vanilla JS with **no CDN and no build
step**, so it runs fully offline.

## Quick Start (Windows)

1. Download `MapEditor/dist/DeceitMapEditor-Windows-x64-v1.1.0.zip`
2. Extract the ZIP
3. Run `Deceit Map Editor.exe`

Level 1 of the original Deceit dungeon is pre-loaded on launch, so you see a real map
immediately.

## Palette (left side)

| Tool | What it does |
|------|--------------|
| **Floor** | Paints a walkable cell rendered in-game as an 11×11 gold/black checkerboard (no walls). |
| **Wall** | Paints a solid grey-brick wall cell. Click cell-by-cell to trace rooms that aren't square. |
| **Fountain** | Places the original Underworld fountain on a cell (auto-sets floor underneath). Click again to remove. |
| **Wrap Border** | Marks a wrap-around border cell. Each border gets an id (W1, W2, …); set its **Exit** in the right panel to the border the player arrives at when crossing. |
| **Erase** | Clears a cell back to empty. |

Click a cell to paint; click-drag to paint many. Switch levels with the tabs across the top.

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
  "version": 1,
  "grid": 8,
  "tilesPerCell": 11,
  "levels": [
    {
      "index": 0,
      "width": 8,
      "height": 8,
      "cells": [0,1,2, ...],                        // 0=empty 1=floor 2=wall, row-major
      "fountains": [ { "x": 4, "y": 4 } ],
      "wrapBorders": [
        { "id": 1, "x": 0, "y": 3, "exit": 2 },     // player crossing W1 arrives at W2
        { "id": 2, "x": 7, "y": 3, "exit": 1 }
      ]
    }
  ]
}
```

`width`/`height` are stored per level so the format can grow beyond 8×8 later.

## Run from source

```bash
cd MapEditor
npm install
npm start
```

## Notes

- Floor and wall painting is playable immediately through the existing `DECEIT.DNG`
  pipeline. Fountains and per-border wrap exits require the engine-side loader to read
  `DECEIT.map.json` (in progress).
- The Windows `.exe` is packaged manually (Wine-based electron-builder is unavailable in
  the build environment); only the `.zip` is tracked in git, not the unpacked folder.
