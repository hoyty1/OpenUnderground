using System.IO;
using UnityEngine;

/// <summary>
/// Builds a Level's tile grid from the Ultima IV DECEIT.DNG dungeon file.
/// Phase 1: walkable geometry only. Each 8×8 U4 cell grid is expanded to
/// an 88×88 UW tile grid (1 U4 cell = 11×11 UW tiles).
/// </summary>
public static class DeceitLoader
{
    private const int CellCount = 8;         // U4 grid is 8×8 cells
    private const int TilesPerCell = 11;     // each cell = 11×11 UW tiles
    private const int GridSize = CellCount * TilesPerCell; // = 88

    /// <summary>
    /// Returns the world-space spawn position for a given Deceit level.
    /// Level 1: cell (col=0, row=0) is always a PASSAGE (0xF0), so spawn
    /// at the center of that cell's UW tile block: tile (5,5).
    /// </summary>
    public static Vector3 SpawnPosition()
    {
        // Center of tile (5,5): offset by 0.5 tiles, then scale.
        // Small +Y offset so the player starts slightly above the floor plane.
        return new Vector3(5.5f * LevelLoader.xzScale, 1.0f, 5.5f * LevelLoader.xzScale);
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
    /// </summary>
    public static void BuildLevel(int uwLevel, Level level)
    {
        string dngPath = Path.Combine(Application.streamingAssetsPath, "DECEIT.DNG");
        if (!File.Exists(dngPath))
        {
            Debug.LogError($"[DeceitLoader] DECEIT.DNG not found at: {dngPath}");
            return;
        }

        byte[] dng = File.ReadAllBytes(dngPath);

        // uwLevel is 1-based; DECEIT.DNG is 0-based at offset deceitIndex * 512
        int deceitIndex = uwLevel - 1;
        int levelOffset = deceitIndex * 512;

        if (levelOffset + 64 > dng.Length)
        {
            Debug.LogError($"[DeceitLoader] DECEIT.DNG too short for level {uwLevel} (offset {levelOffset})");
            return;
        }

        // Resize the level to 88×88
        level.ResizeTiles(GridSize, GridSize);

        // Initialize all tiles as solid walls
        for (int y = 0; y < GridSize; y++)
        {
            for (int x = 0; x < GridSize; x++)
            {
                Tile t = new Tile();
                t.x = x;
                t.y = y;
                t.type = 0;        // solid
                t.floorHeight = 0;
                t.wallTexture = 0; // UW1 Level 1 stone texture
                t.floorTexture = 0;
                t.firstObject = 0;
                level.tiles[x, y] = t;
            }
        }

        // Expand each U4 8×8 cell to 11×11 UW tiles
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
                    }
                }
            }
        }

        Debug.Log($"[DeceitLoader] Built level {uwLevel} ({GridSize}×{GridSize} tiles).");
    }
}
