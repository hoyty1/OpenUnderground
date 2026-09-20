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
    [Serializable] public class DeceitLevel
    {
        public int index, width, height;
        public int[] cells;               // row-major, length width*height; 0=empty,1=floor,2=wall
        public DeceitPoint spawn;          // player start cell for this level (may be null)
        public DeceitPoint[] fountains;    // cell coordinates
        public DeceitBorder[] wrapBorders; // seamless-wrap link markers (used in a later step)
    }
    [Serializable] public class DeceitMap { public int version, tilesPerCell; public DeceitLevel[] levels; }

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

        for (int cy = 0; cy < ch; cy++)
        {
            for (int cx = 0; cx < cw; cx++)
            {
                int code = sc.cells[cy * cw + cx];
                bool isPassable = code == 1; // 0=empty, 1=floor, 2=wall — only floor is walkable

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
                            t.floorTexture = (dx + dy) % 2; // per-tile gold/black checkerboard
                        }
                    }
                }
            }
        }

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

        Debug.Log($"[DeceitLoader] Built level {uwLevel} from sidecar ({cw}×{ch} cells → {gw}×{gh} tiles).");
    }

    /// <summary>Legacy path: builds the classic 8×8 U4 grid from DECEIT.DNG.</summary>
    private static void BuildFromDng(int uwLevel, Level level)
    {
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
}
