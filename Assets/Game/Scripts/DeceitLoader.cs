using System;
using System.IO;
using UnityEngine;

/// <summary>
/// Builds a Level's tile grid for the Dungeon Deceit dungeons.
///
/// Two data sources, in priority order:
///   1. DECEIT.map.json (the map editor's sidecar) — authoritative. Supports arbitrary
///      per-level dimensions (not just 8×8), floor/empty/wall cells, fountains and wrap
///      borders. This is the real Deceit geometry authored in the Windows map editor.
///   2. DECEIT.DNG (legacy Ultima IV dungeon file) — fallback when no sidecar level exists.
///      The classic 8×8 U4 cell grid, expanded to (8*TilesPerCell)² UW tiles.
///
/// Each authored cell is expanded to TilesPerCell×TilesPerCell UW tiles so corridors have
/// real width and the checkerboard floor reads correctly at game scale.
/// Phase 1: walkable geometry + fountains. Monsters/items are deferred.
/// </summary>
public static class DeceitLoader
{
    private const int CellCount = 8;         // legacy U4 grid is 8×8 cells
    public  const int TilesPerCell = 11;     // UW tiles per authored cell — each Deceit square = 11×11 floor tiles

    // Player spawn, in UW TILE coordinates (NOT cell coordinates). Set during BuildLevel
    // to the centre tile of a valid floor cell. Defaults to the centre of legacy cell (4,4).
    public static int SpawnCellX = 4 * TilesPerCell + TilesPerCell / 2;
    public static int SpawnCellY = 4 * TilesPerCell + TilesPerCell / 2;

    private const int GridSize = CellCount * TilesPerCell; // legacy fallback size (= 88 at TilesPerCell=11)

    // ---- Sidecar (DECEIT.map.json) data model -------------------------------------------
    // Kept in sync with the map editor's buildSidecar(): version 2, row-major cells,
    // cell codes 0=empty, 1=floor, 2=wall. Border ids are 1-based; exit dir value 0 = none.
    [Serializable] public class DeceitExits { public int N, E, S, W; }
    [Serializable] public class DeceitPoint { public int x, y; }
    [Serializable] public class DeceitBorder { public int id, x, y; public DeceitExits exits; }
    // A staircase placed in a cell. kind: "up" | "down" | "exit".
    // For up/down, targetLevel is a sidecar level index (0-based) and targetId is the
    // id of the destination stair on that level. For "exit" those fields are unused.
    [Serializable] public class DeceitStair { public int id, x, y; public string kind; public int targetLevel, targetId; }
    // A decorative world object (fountain-style) placed in a cell. type == EObjectType value
    // (== OBJECTS.GR sprite index). x,y are cell coordinates.
    [Serializable] public class DeceitObject { public int type, x, y; }
    // Per-cell sub-tile texture overrides (sidecar version 4), authored in the zoom editor.
    // cell = row-major cell index (cy*width+cx) in EDITOR space (row 0 = north).
    // floor/wall are length TilesPerCell*TilesPerCell (121), row-major within the cell with
    // sub-row 0 = north and sub-col 0 = west. Each entry is a floorMat/wallMat index, or -1
    // = "no sub override" (fall back to the cell's uniform floor / neighbour wall default).
    [Serializable] public class DeceitSubtile { public int cell; public int[] floor; public int[] wall; }
    [Serializable] public class DeceitLevel
    {
        public int index, width, height;
        public int[] cells;               // row-major, length width*height; 0=empty,1=floor,2=wall
        public DeceitPoint spawn;          // player start cell for this level (may be null)
        public DeceitPoint[] fountains;    // cell coordinates
        public DeceitBorder[] wrapBorders; // seamless-wrap link markers (used in a later step)
        public DeceitStair[] stairs;       // staircases (up/down/exit) for inter-level travel
        // ---- Per-cell texture overrides (sidecar version 3) ----
        // wallTex/floorTex are row-major, length width*height, aligned to cells[].
        //   wallTex[i]  = wallMat index 0..209 for wall cells, -1 = engine default wall.
        //   floorTex[i] = floorMat index 0..51 for floor cells, -1 = gold/black checkerboard.
        // ceilTex is level-wide and 1-BASED (floorMat index + 1); 0 = unset (keep default),
        //   because JsonUtility reports an absent scalar as 0 and 0 is a valid floorMat index.
        public int[] wallTex;
        public int[] floorTex;
        public int ceilTex;
        public DeceitObject[] objects;     // decorative world objects (cell coordinates)
        // ---- Per-cell ceiling height + sub-tile textures (sidecar version 4) ----
        // cellHeight is row-major, length width*height, aligned to cells[]. 0 = default (16),
        //   otherwise the ceiling/wall height in 1..16 units (JsonUtility reports absent as 0).
        public int[] cellHeight;
        public DeceitSubtile[] subtiles;   // sparse: only cells painted in the zoom editor
    }
    [Serializable] public class DeceitMap { public int version, tilesPerCell; public DeceitLevel[] levels; }

    // ---- Deceit per-level texture palettes (consumed by LevelGeometry) --------------------
    // The engine mesh has a fixed 48 wall + 10 floor material slots. In Deceit mode we pack
    // the level's distinct chosen textures into those slots and point each tile's
    // wall/floorTexture at the right slot. LevelGeometry reads these after BuildLevel runs.
    //   WallPalette[slot]  = wallMat index for that wall slot  (slot 0 = default wall).
    //   FloorPalette[slot] = floorMat index for that floor slot, or -1 = leave as-is.
    //     floor slots 0/1 are the black/gold checkerboard (handled in LevelGeometry),
    //     slots 2..8 are explicit floors, slot 9 is the ceiling (-1 = keep default ceiling).
    public static int[] WallPalette;
    public static int[] FloorPalette;
    public static int WallPaletteOverflow;
    public static int FloorPaletteOverflow;

    public const int DefaultWallMat  = 0;   // wallMat index used for the default wall slot
    public const int MaxWallSlots    = 48;  // wall submesh slots 0..47 (slot 0 = default)
    public const int FirstFloorSlot  = 2;   // floor slots 2..8 hold explicit floor textures
    public const int LastFloorSlot   = 8;   // (slots 0/1 = checkerboard, slot 9 = ceiling)

    private static DeceitMap sMap;
    private static bool sMapLoaded;

    /// <summary>Parses DECEIT.map.json from StreamingAssets once and caches it (null if absent/invalid).</summary>
    public static DeceitMap LoadMap()
    {
        if (sMapLoaded) return sMap;
        sMapLoaded = true;

        string mapPath = Path.Combine(Application.streamingAssetsPath, "DECEIT.map.json");
        if (!File.Exists(mapPath))
        {
            Debug.Log("[DeceitLoader] No DECEIT.map.json sidecar found; using legacy DECEIT.DNG.");
            return null;
        }

        try
        {
            string json = File.ReadAllText(mapPath);
            sMap = JsonUtility.FromJson<DeceitMap>(json);
            int levelCount = (sMap != null && sMap.levels != null) ? sMap.levels.Length : 0;
            Debug.Log($"[DeceitLoader] Loaded DECEIT.map.json (version {(sMap != null ? sMap.version : 0)}, {levelCount} levels).");
        }
        catch (Exception e)
        {
            Debug.LogError($"[DeceitLoader] Failed to parse DECEIT.map.json: {e.Message}");
            sMap = null;
        }
        return sMap;
    }

    /// <summary>Returns the sidecar level whose index matches deceitIndex (0-based), or null.</summary>
    public static DeceitLevel GetSidecarLevel(int deceitIndex)
    {
        DeceitMap map = LoadMap();
        if (map == null || map.levels == null) return null;
        foreach (DeceitLevel lv in map.levels)
        {
            if (lv != null && lv.index == deceitIndex) return lv;
        }
        return null;
    }

    /// <summary>
    /// Returns the world-space spawn position (fallback when GetTile is unavailable).
    /// SpawnCellX/Y are UW tile coordinates; each tile is LevelLoader.xzScale metres.
    /// </summary>
    public static Vector3 SpawnPosition()
    {
        float cx = (SpawnCellX + 0.5f) * LevelLoader.xzScale;
        float cz = (SpawnCellY + 0.5f) * LevelLoader.xzScale;
        return new Vector3(cx, 1.0f, cz);
    }

    /// <summary>
    /// Equips the player with a full lit lantern (right shoulder) and three oil flasks
    /// so they can see in Deceit's otherwise pitch-black dungeons.
    /// Called once after the level is loaded and the player is spawned.
    /// Uses the same CreateObjectOfType + Inventory.Add path as save restore, so the
    /// existing light-decay / oil-refuelling / flickering systems all work normally.
    /// </summary>
    public static void EquipStartingLantern()
    {
        if (Inventory.sInv == null)
        {
            Debug.LogWarning("[DeceitLoader] EquipStartingLantern: Inventory not ready.");
            return;
        }

        // Don't double-equip if a light source is already on a shoulder (e.g. from cheats).
        if (Inventory.sInv.invSlotContents[(int)EInvSlot.RightShoulder] is LightSource
            || Inventory.sInv.invSlotContents[(int)EInvSlot.LeftShoulder] is LightSource)
        {
            return;
        }

        // Create a full lantern and equip it to the right shoulder.
        // Pattern mirrors SaveGameManager restore: Create -> set quality -> PostLoadInitialize
        //   -> assign slot -> Equip() (which calls SetLit(true) when quality > 0).
        UUObject lanternObj = LevelLoader.CreateObjectOfType(EObjectType.Lantern);
        if (lanternObj == null)
        {
            Debug.LogWarning("[DeceitLoader] EquipStartingLantern: Failed to create Lantern.");
        }
        else
        {
            lanternObj.quality = 63; // max — full lantern
            lanternObj.quantity = 1;
            lanternObj.PostLoadInitialize();
            Inventory.sInv.invSlotContents[(int)EInvSlot.RightShoulder] = lanternObj;
            lanternObj.Equip(); // lights the lantern
        }

        // Create a stack of 3 oil flasks so the player can refuel.
        UUObject oilObj = LevelLoader.CreateObjectOfType(EObjectType.OilFlask);
        if (oilObj != null)
        {
            oilObj.quality = 63;
            oilObj.quantity = 3;
            oilObj.PostLoadInitialize();
            Inventory.Add(oilObj);
        }

        Debug.Log("[DeceitLoader] Equipped starting lantern (full) + 3 oil flasks.");
    }

    /// <summary>
    /// Populates the given Level's tile grid with Deceit dungeon geometry.
    /// uwLevel is 1-based (matching loadedLevel in LevelLoader).
    /// Prefers the sidecar (arbitrary dims); falls back to the legacy 8×8 DECEIT.DNG.
    /// </summary>
    public static void BuildLevel(int uwLevel, Level level)
    {
        int deceitIndex = uwLevel - 1;

        DeceitLevel sc = GetSidecarLevel(deceitIndex);
        if (sc != null && sc.cells != null && sc.width > 0 && sc.height > 0
            && sc.cells.Length >= sc.width * sc.height)
        {
            BuildFromSidecar(uwLevel, level, sc);
        }
        else
        {
            BuildFromDng(uwLevel, level);
        }
    }

    /// <summary>Builds an arbitrary-size level from the editor sidecar.</summary>
    private static void BuildFromSidecar(int uwLevel, Level level, DeceitLevel sc)
    {
        int cw = sc.width;
        int ch = sc.height;
        int gw = cw * TilesPerCell;
        int gh = ch * TilesPerCell;

        level.ResizeTiles(gw, gh);
        InitSolid(level, gw, gh);

        // ---- Build the per-level texture palettes from the sidecar overrides ----------
        // wallMat has 210 entries, floorMat has 52 (see LevelLoader.CreateWallAndFloorMaterials);
        // we map the distinct chosen indices into the fixed 48 wall / 10 floor mesh slots.
        int[] wallPal  = new int[MaxWallSlots];   // slot -> wallMat index (-1 = unused)
        int[] floorPal = new int[10];             // slot -> floorMat index (-1 = leave as-is)
        for (int s = 0; s < wallPal.Length;  s++) wallPal[s]  = -1;
        for (int s = 0; s < floorPal.Length; s++) floorPal[s] = -1;
        wallPal[0] = DefaultWallMat;              // slot 0 is always the default wall
        int wallOverflow = 0, floorOverflow = 0;

        var wallSlotMap = new System.Collections.Generic.Dictionary<int, int>();
        int nextWallSlot = 1;                     // slots 1..47 for explicit walls
        // Returns the wall slot for a wallMat index (0 = default/overflow).
        System.Func<int, int> wallSlotFor = (mat) =>
        {
            if (mat < 0) return 0;                // -1 sentinel -> default wall
            if (wallSlotMap.TryGetValue(mat, out int slot)) return slot;
            if (nextWallSlot < MaxWallSlots)
            {
                slot = nextWallSlot++;
                wallSlotMap[mat] = slot;
                wallPal[slot] = mat;
                return slot;
            }
            wallOverflow++;
            return 0;                             // out of slots -> default wall
        };

        var floorSlotMap = new System.Collections.Generic.Dictionary<int, int>();
        int nextFloorSlot = FirstFloorSlot;       // slots 2..8 for explicit floors
        // Returns the floor slot for a floorMat index (-1 = keep checkerboard/overflow).
        System.Func<int, int> floorSlotFor = (mat) =>
        {
            if (mat < 0) return -1;               // -1 sentinel -> checkerboard
            if (floorSlotMap.TryGetValue(mat, out int slot)) return slot;
            if (nextFloorSlot <= LastFloorSlot)
            {
                slot = nextFloorSlot++;
                floorSlotMap[mat] = slot;
                floorPal[slot] = mat;
                return slot;
            }
            floorOverflow++;
            return -1;                            // out of slots -> checkerboard
        };

        // Level-wide ceiling texture (slot 9). ceilTex is 1-based; 0 = keep engine default.
        if (sc.ceilTex > 0)
        {
            int cm = sc.ceilTex - 1;
            if (cm >= 0 && cm < 52) floorPal[9] = cm;
        }

        bool haveWallTex  = sc.wallTex  != null && sc.wallTex.Length  >= cw * ch;
        bool haveFloorTex = sc.floorTex != null && sc.floorTex.Length >= cw * ch;
        bool haveCellHeight = sc.cellHeight != null && sc.cellHeight.Length >= cw * ch;

        // Index the sparse sub-tile overrides by editor cell index for O(1) lookup.
        var subMap = new System.Collections.Generic.Dictionary<int, DeceitSubtile>();
        if (sc.subtiles != null)
            foreach (DeceitSubtile stx in sc.subtiles)
                if (stx != null) subMap[stx.cell] = stx;

        for (int cy = 0; cy < ch; cy++)
        {
            for (int cx = 0; cx < cw; cx++)
            {
                int code = sc.cells[cy * cw + cx];
                bool isPassable = code == 1; // 0=empty, 1=floor, 2=wall — only floor is walkable

                // Resolve this floor cell's explicit floor texture -> a uniform slot (or -1).
                int floorSlot = -1;
                if (isPassable && haveFloorTex)
                    floorSlot = floorSlotFor(sc.floorTex[cy * cw + cx]);

                // Per-cell ceiling height (0 = default 16), applied to every floor tile of the cell.
                int cellCeil = 16;
                if (isPassable && haveCellHeight)
                {
                    int hv = sc.cellHeight[cy * cw + cx];
                    if (hv > 0) cellCeil = Mathf.Clamp(hv, 1, 16);
                }

                // Sub-tile floor overrides for this cell (null = none).
                int[] subFloor = null;
                if (isPassable && subMap.TryGetValue(cy * cw + cx, out DeceitSubtile subCell) && subCell != null)
                    subFloor = subCell.floor;

                int uxBase = cx * TilesPerCell;
                // Flip N/S: sidecar row 0 is north (minimap top). +z is north in-world,
                // so build sidecar row cy at world row (ch-1-cy) to match compass/minimap.
                int uyBase = (ch - 1 - cy) * TilesPerCell;
                for (int dy = 0; dy < TilesPerCell; dy++)
                {
                    for (int dx = 0; dx < TilesPerCell; dx++)
                    {
                        Tile t = level.tiles[uxBase + dx, uyBase + dy];
                        t.type = isPassable ? 1 : 0;
                        if (isPassable)
                        {
                            // Editor sub-grid row 0 = north = engine dy = TilesPerCell-1.
                            int subIdx = (TilesPerCell - 1 - dy) * TilesPerCell + dx;
                            int subMat = (subFloor != null && subIdx < subFloor.Length) ? subFloor[subIdx] : -1;
                            if (subMat >= 0)
                                t.floorTexture = floorSlotFor(subMat);   // individual painted floor
                            else
                                t.floorTexture = (floorSlot >= 0)
                                    ? floorSlot            // uniform explicit floor
                                    : (dx + dy) % 2;       // gold/black checkerboard
                            t.ceilHeight = cellCeil;
                        }
                    }
                }
            }
        }

        // ---- Second pass: paint wall textures onto floor tiles facing textured wall cells ---
        // A wall face is generated on the FLOOR tile adjacent to a higher (solid) neighbour and
        // uses that floor tile's wallTexture. So for each floor cell we inspect its four
        // neighbours; a neighbour that is a WALL cell (code 2) with an explicit texture paints
        // the matching perimeter row/column of this cell's 11×11 block. N/S are painted first,
        // then W/E, so corner tiles follow the West/East texture when two walls disagree.
        if (haveWallTex)
        {
            for (int cy = 0; cy < ch; cy++)
            {
                for (int cx = 0; cx < cw; cx++)
                {
                    if (sc.cells[cy * cw + cx] != 1) continue; // only floor cells draw walls
                    int uxBase = cx * TilesPerCell;
                    int uyBase = (ch - 1 - cy) * TilesPerCell;

                    int nMat = WallTexOfCell(sc, cx, cy - 1, cw, ch); // north neighbour
                    int sMat = WallTexOfCell(sc, cx, cy + 1, cw, ch); // south neighbour
                    int wMat = WallTexOfCell(sc, cx - 1, cy, cw, ch); // west neighbour
                    int eMat = WallTexOfCell(sc, cx + 1, cy, cw, ch); // east neighbour

                    // North neighbour -> top row of block (dy = TPC-1); South -> bottom (dy = 0).
                    if (nMat >= 0)
                    {
                        int slot = wallSlotFor(nMat);
                        for (int dx = 0; dx < TilesPerCell; dx++)
                            level.tiles[uxBase + dx, uyBase + TilesPerCell - 1].wallTexture = slot;
                    }
                    if (sMat >= 0)
                    {
                        int slot = wallSlotFor(sMat);
                        for (int dx = 0; dx < TilesPerCell; dx++)
                            level.tiles[uxBase + dx, uyBase].wallTexture = slot;
                    }
                    // West neighbour -> left column (dx = 0); East -> right column (dx = TPC-1).
                    if (wMat >= 0)
                    {
                        int slot = wallSlotFor(wMat);
                        for (int dy = 0; dy < TilesPerCell; dy++)
                            level.tiles[uxBase, uyBase + dy].wallTexture = slot;
                    }
                    if (eMat >= 0)
                    {
                        int slot = wallSlotFor(eMat);
                        for (int dy = 0; dy < TilesPerCell; dy++)
                            level.tiles[uxBase + TilesPerCell - 1, uyBase + dy].wallTexture = slot;
                    }
                }
            }
        }

        // ---- Sub-tile wall overrides: individual wall faces painted in the zoom editor win
        // over the neighbour-cell defaults set above. ----
        if (sc.subtiles != null)
        {
            foreach (DeceitSubtile st in sc.subtiles)
            {
                if (st == null || st.wall == null) continue;
                int scx = st.cell % cw;
                int scy = st.cell / cw;
                if (scx < 0 || scx >= cw || scy < 0 || scy >= ch) continue;
                if (sc.cells[scy * cw + scx] != 1) continue; // only floor cells draw walls
                int uxBase = scx * TilesPerCell;
                int uyBase = (ch - 1 - scy) * TilesPerCell;
                for (int dy = 0; dy < TilesPerCell; dy++)
                {
                    for (int dx = 0; dx < TilesPerCell; dx++)
                    {
                        int subIdx = (TilesPerCell - 1 - dy) * TilesPerCell + dx;
                        if (subIdx >= st.wall.Length) continue;
                        int mat = st.wall[subIdx];
                        if (mat >= 0)
                            level.tiles[uxBase + dx, uyBase + dy].wallTexture = wallSlotFor(mat);
                    }
                }
            }
        }

        // Publish palettes for LevelGeometry to overlay onto the mesh materials.
        WallPalette  = wallPal;
        FloorPalette = floorPal;
        WallPaletteOverflow  = wallOverflow;
        FloorPaletteOverflow = floorOverflow;
        if (wallOverflow > 0)
            Debug.LogWarning($"[DeceitLoader] Level {uwLevel}: {wallOverflow} distinct wall texture(s) exceeded the 47-slot limit and fell back to the default wall.");
        if (floorOverflow > 0)
            Debug.LogWarning($"[DeceitLoader] Level {uwLevel}: {floorOverflow} distinct floor texture(s) exceeded the 7-slot limit and fell back to the checkerboard.");

        // Prefer the spawn point painted in the map editor; fall back to a chosen floor cell.
        if (sc.spawn != null && sc.spawn.x >= 0 && sc.spawn.x < cw && sc.spawn.y >= 0 && sc.spawn.y < ch
            && sc.cells[sc.spawn.y * cw + sc.spawn.x] == 1)
        {
            SpawnCellX = sc.spawn.x * TilesPerCell + TilesPerCell / 2;
            SpawnCellY = (ch - 1 - sc.spawn.y) * TilesPerCell + TilesPerCell / 2; // N/S flip
            Debug.Log($"[DeceitLoader] Level {uwLevel} spawn set from editor paint at cell ({sc.spawn.x},{sc.spawn.y}).");
        }
        else
        {
            ChooseSpawnCell(sc.cells, cw, ch);
        }

        // Mark staircase centre tiles as stairs so the minimap draws the stair icon.
        if (sc.stairs != null)
        {
            for (int i = 0; i < sc.stairs.Length; i++)
            {
                DeceitStair st = sc.stairs[i];
                if (st == null) continue;
                if (st.x < 0 || st.x >= cw || st.y < 0 || st.y >= ch) continue;
                int stx = st.x * TilesPerCell + TilesPerCell / 2;
                int sty = (ch - 1 - st.y) * TilesPerCell + TilesPerCell / 2; // N/S flip
                if (stx >= 0 && stx < gw && sty >= 0 && sty < gh)
                {
                    level.tiles[stx, sty].isStair = true;
                }
            }
        }

        Debug.Log($"[DeceitLoader] Built level {uwLevel} from sidecar ({cw}×{ch} cells → {gw}×{gh} tiles).");
    }

    /// <summary>Legacy path: builds the classic 8×8 U4 grid from DECEIT.DNG.</summary>
    private static void BuildFromDng(int uwLevel, Level level)
    {
        // Legacy path has no per-cell texture data; clear any palette left by a sidecar level
        // so LevelGeometry falls back to the plain gold/black checkerboard for this level.
        WallPalette = null;
        FloorPalette = null;
        WallPaletteOverflow = 0;
        FloorPaletteOverflow = 0;

        string dngPath = Path.Combine(Application.streamingAssetsPath, "DECEIT.DNG");
        if (!File.Exists(dngPath))
        {
            Debug.LogError($"[DeceitLoader] DECEIT.DNG not found at: {dngPath}");
            return;
        }

        byte[] dng = File.ReadAllBytes(dngPath);

        int deceitIndex = uwLevel - 1;
        int levelOffset = deceitIndex * 512;
        if (levelOffset + 64 > dng.Length)
        {
            Debug.LogError($"[DeceitLoader] DECEIT.DNG too short for level {uwLevel} (offset {levelOffset})");
            return;
        }

        level.ResizeTiles(GridSize, GridSize);
        InitSolid(level, GridSize, GridSize);

        for (int row = 0; row < CellCount; row++)
        {
            for (int col = 0; col < CellCount; col++)
            {
                byte cell = dng[levelOffset + row * CellCount + col];
                int typeNibble = (cell >> 4) & 0xF;
                bool isPassable = typeNibble != 0x0;

                int uxBase = col * TilesPerCell;
                int uyBase = row * TilesPerCell;
                for (int dy = 0; dy < TilesPerCell; dy++)
                {
                    for (int dx = 0; dx < TilesPerCell; dx++)
                    {
                        Tile t = level.tiles[uxBase + dx, uyBase + dy];
                        t.type = isPassable ? 1 : 0;
                        if (isPassable)
                        {
                            t.floorTexture = (dx + dy) % 2;
                        }
                    }
                }
            }
        }

        // Legacy spawn: centre tile of cell (4,4).
        SpawnCellX = 4 * TilesPerCell + TilesPerCell / 2;
        SpawnCellY = 4 * TilesPerCell + TilesPerCell / 2;

        Debug.Log($"[DeceitLoader] Built level {uwLevel} from DECEIT.DNG ({GridSize}×{GridSize} tiles).");
    }

    /// <summary>
    /// Returns the wallMat index authored for the cell at (cx,cy), or -1 when that cell is
    /// out of bounds, is not an explicit wall cell (code 2), or has no texture override.
    /// </summary>
    private static int WallTexOfCell(DeceitLevel sc, int cx, int cy, int cw, int ch)
    {
        if (cx < 0 || cx >= cw || cy < 0 || cy >= ch) return -1;
        int i = cy * cw + cx;
        if (sc.cells[i] != 2) return -1;                    // only explicit wall cells carry a texture
        if (sc.wallTex == null || i >= sc.wallTex.Length) return -1;
        return sc.wallTex[i];                               // may be -1 (default wall)
    }

    /// <summary>Fills every tile of the level with a solid (type 0) wall tile.</summary>
    private static void InitSolid(Level level, int gw, int gh)
    {
        for (int y = 0; y < gh; y++)
        {
            for (int x = 0; x < gw; x++)
            {
                Tile t = new Tile();
                t.x = x;
                t.y = y;
                t.type = 0;        // solid
                t.floorHeight = 0;
                t.wallTexture = 0;
                t.floorTexture = 0;
                t.firstObject = 0;
                level.tiles[x, y] = t;
            }
        }
    }

    /// <summary>
    /// Sets SpawnCellX/Y (tile coords) to the centre tile of a floor cell — preferring the
    /// grid centre, otherwise the first floor cell found.
    /// </summary>
    private static void ChooseSpawnCell(int[] cells, int cw, int ch)
    {
        int scx = cw / 2;
        int scy = ch / 2;
        if (!(scx < cw && scy < ch && cells[scy * cw + scx] == 1))
        {
            bool found = false;
            for (int cy = 0; cy < ch && !found; cy++)
            {
                for (int cx = 0; cx < cw && !found; cx++)
                {
                    if (cells[cy * cw + cx] == 1)
                    {
                        scx = cx;
                        scy = cy;
                        found = true;
                    }
                }
            }
        }
        SpawnCellX = scx * TilesPerCell + TilesPerCell / 2;
        SpawnCellY = (ch - 1 - scy) * TilesPerCell + TilesPerCell / 2; // N/S flip
    }

    /// <summary>
    /// Places a fountain world object at the centre of every fountain cell in the current
    /// sidecar level. Call after the level is loaded and objectModelMap is ready
    /// (i.e. from the same post-load hook as EquipStartingLantern).
    /// </summary>
    public static void PlaceFountains()
    {
        if (LevelLoader.sLevelLoader == null) return;
        int deceitIndex = LevelLoader.sLevelLoader.loadedLevel - 1;

        DeceitLevel sc = GetSidecarLevel(deceitIndex);
        if (sc == null || sc.fountains == null || sc.fountains.Length == 0)
        {
            return;
        }

        int placed = 0;
        foreach (DeceitPoint f in sc.fountains)
        {
            if (f == null) continue;

            int tx = f.x * TilesPerCell + TilesPerCell / 2;
            int ty = (sc.height - 1 - f.y) * TilesPerCell + TilesPerCell / 2; // N/S flip
            Tile t = LevelLoader.GetTile(tx, ty);

            UUObject fo = LevelLoader.CreateObjectOfType(EObjectType.Fountain);
            if (fo == null) continue;

            fo.quality = 1;
            fo.quantity = 1;
            fo.PostLoadInitialize();

            Vector3 pos = (t != null)
                ? t.GetCenter()
                : new Vector3((tx + 0.5f) * LevelLoader.xzScale, 0.0f, (ty + 0.5f) * LevelLoader.xzScale);
            fo.transform.position = pos;

            LevelLoader.AddToWorld(fo);
            placed++;
        }

        Debug.Log($"[DeceitLoader] Placed {placed} fountain(s) for level {deceitIndex + 1}.");
    }

    /// <summary>
    /// Places the authored decorative world objects (from the sidecar's objects[]) at the
    /// centre of their cells. Each object's type is an EObjectType value (== OBJECTS.GR sprite
    /// index), so this covers fountains, cauldrons, shrines, furniture, boulders, etc.
    /// Mirrors PlaceFountains' Create -> quality/quantity -> PostLoadInitialize -> position ->
    /// AddToWorld path so it uses the same runtime object pipeline. Call from the same post-load
    /// hook as PlaceFountains.
    /// </summary>
    public static void PlaceObjects()
    {
        if (LevelLoader.sLevelLoader == null) return;
        int deceitIndex = LevelLoader.sLevelLoader.loadedLevel - 1;

        DeceitLevel sc = GetSidecarLevel(deceitIndex);
        if (sc == null || sc.objects == null || sc.objects.Length == 0)
        {
            return;
        }

        int placed = 0;
        foreach (DeceitObject o in sc.objects)
        {
            if (o == null) continue;
            if (o.x < 0 || o.x >= sc.width || o.y < 0 || o.y >= sc.height) continue;

            int tx = o.x * TilesPerCell + TilesPerCell / 2;
            int ty = (sc.height - 1 - o.y) * TilesPerCell + TilesPerCell / 2; // N/S flip
            Tile t = LevelLoader.GetTile(tx, ty);

            UUObject obj = LevelLoader.CreateObjectOfType((EObjectType)o.type);
            if (obj == null)
            {
                Debug.LogWarning($"[DeceitLoader] PlaceObjects: could not create object type {o.type} at cell ({o.x},{o.y}).");
                continue;
            }

            obj.quality = 1;
            obj.quantity = 1;
            obj.PostLoadInitialize();

            Vector3 pos = (t != null)
                ? t.GetCenter()
                : new Vector3((tx + 0.5f) * LevelLoader.xzScale, 0.0f, (ty + 0.5f) * LevelLoader.xzScale);
            obj.transform.position = pos;

            LevelLoader.AddToWorld(obj);
            placed++;
        }

        Debug.Log($"[DeceitLoader] Placed {placed} decorative object(s) for level {deceitIndex + 1}.");
    }
}
