# Deceit Map Editor

Visual editor for Ultima IV Deceit dungeon levels (`DECEIT.DNG` format) for use with the OpenUnderground Unity engine.

## Features

- **8×8 Grid Editor** for all 9 dungeon levels
- **Cell Types**: Wall, Passage, Door, Ladder Up/Down, Special Room
- **Connectivity Analysis**: BFS flood-fill shows disconnected regions
- **Wrap-Around Toggle**: View map as torus topology (U4 dungeon standard)
- **Spawn Tracking**: Highlights the player spawn cell (4,4) and its region
- **Binary I/O**: Import/export DECEIT.DNG files (preserves metadata beyond first 64 bytes)
- **Keyboard Shortcuts**: W/P/D/U/L/S for instant cell type assignment, arrows for navigation

## Installation

```bash
cd MapEditor
npm install
```

## Running

```bash
npm start
```

## Building Standalone Executable

```bash
npm run build
```

Output will be in `MapEditor/dist/`.

## Usage

### Editing Cells
- **Left-click**: Cycle through cell types (Wall → Passage → Door → Ladder Up → Ladder Down → Special → Wall)
- **Right-click**: Set to Wall immediately
- **Keyboard**: Select a cell, then press W/P/D/U/L/S to set type directly
- **Arrow keys**: Navigate selected cell

### View Options
- **Show Regions**: Toggle connectivity overlay (each disconnected region gets a color)
- **Wrap Around**: Toggle torus topology for connectivity analysis (default: ON, matching U4 behavior)

### File Operations
- **Open DECEIT.DNG**: Load existing dungeon file (all 9 levels)
- **Export DECEIT.DNG**: Save edited map (preserves original metadata if file was loaded)

## File Format

`DECEIT.DNG` contains 9 levels, each 512 bytes:
- First 64 bytes: 8×8 cell grid (row-major, high nibble = type)
- Remaining 448 bytes: metadata (preserved on export if file was loaded)

### Cell Type Values (High Nibble)
- `0x0` = Wall/Solid
- `0x1` = Ladder Up
- `0x2` = Ladder Down
- `0x3-0xB` = Passage variants
- `0xC` = Door
- `0xD` = Special Room
- `0xE-0xF` = Passage

## Default Data

Level 1 is pre-loaded with the original Ultima IV Deceit dungeon layout for immediate use.

## Integration with OpenUnderground

Place the exported `DECEIT.DNG` in `Assets/StreamingAssets/` and enable Deceit mode in the engine (`LevelLoader.deceitMode = true`).

## License

MIT
