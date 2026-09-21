using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Runtime staircase driver for Deceit mode.
///
/// Replicates the base-game stair mechanic (a MoveTrigger linked to a TeleportTrap that
/// calls LevelLoader.ChangeLevel) with a single persistent singleton instead of a pair of
/// per-stair objects. Each frame it reads the current sidecar level's staircases (authored
/// in the map editor) and checks the player's tile:
///
///   • "down" / "up" → fires when the player walks into the single stairway wall tile, then
///                     LevelLoader.ChangeLevel lands them stepping out of the linked
///                     destination stairway, facing into that room.
///   • "exit"        → fires on the cell centre tile; returns to the World scene.
///
/// A re-arm flag prevents repeated firing while the player remains on the stair tile after a
/// teleport; it resets once the player steps off every stair tile.
///
/// Usage: call DeceitStairManager.Ensure() once after the Deceit game starts. The singleton
/// survives level changes (DontDestroyOnLoad), so it keeps working after every ChangeLevel.
/// </summary>
public class DeceitStairManager : MonoBehaviour
{
    private static DeceitStairManager _instance;

    /// <summary>Create the stair driver once. Safe to call repeatedly.</summary>
    public static void Ensure()
    {
        if (_instance != null) return;
        GameObject host = new GameObject("DeceitStairManager");
        DontDestroyOnLoad(host);
        _instance = host.AddComponent<DeceitStairManager>();
    }

    // True when the player is clear of all stair tiles and a fresh trigger is allowed.
    private bool _armed = true;

    private void Update()
    {
        LevelLoader ll = LevelLoader.sLevelLoader;
        if (ll == null || !ll.deceitMode) return;
        if (PlayerObject.Player == null) return;

        DeceitLoader.DeceitLevel sc = DeceitLoader.GetSidecarLevel(ll.loadedLevel - 1);
        if (sc == null || sc.stairs == null || sc.stairs.Length == 0) return;

        // Player's current tile (same grid convention BuildFromSidecar uses).
        Vector3 pos = PlayerObject.Player.transform.position;
        int px = (int)(pos.x / LevelLoader.xzScale);
        int py = (int)(pos.z / LevelLoader.xzScale);

        DeceitLoader.DeceitStair onStair = null;
        for (int i = 0; i < sc.stairs.Length; i++)
        {
            DeceitLoader.DeceitStair st = sc.stairs[i];
            if (st == null) continue;
            string k = st.kind != null ? st.kind.ToLowerInvariant() : "down";
            bool hit;
            if (k == "exit")
            {
                // Exit stairs have no wall stairway; trigger on the cell's centre tile.
                int stx = st.x * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2;
                int sty = (sc.height - 1 - st.y) * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2; // N/S flip
                hit = (px == stx && py == sty);
            }
            else
            {
                // up/down: trigger when the player walks into the single stairway wall tile.
                hit = OnStairEdge(sc, st, px, py);
            }
            if (hit) { onStair = st; break; }
        }

        if (onStair == null)
        {
            _armed = true; // stepped clear of every stair — ready to fire again
            return;
        }

        if (!_armed) return; // still standing on the stair we just used
        _armed = false;

        Fire(onStair);
    }

    private void Fire(DeceitLoader.DeceitStair st)
    {
        string kind = st.kind != null ? st.kind.ToLowerInvariant() : "down";

        if (kind == "exit")
        {
            Debug.Log("[DeceitStairManager] Exit stair — leaving the dungeon.");
            SceneManager.LoadScene("World");
            return;
        }

        // up / down: find the destination level and the linked destination stair.
        DeceitLoader.DeceitLevel dest = DeceitLoader.GetSidecarLevel(st.targetLevel);
        if (dest == null)
        {
            Debug.LogWarning($"[DeceitStairManager] Stair id {st.id} ({kind}) has no destination level {st.targetLevel}.");
            return;
        }

        DeceitLoader.DeceitStair target = null;
        if (dest.stairs != null)
        {
            for (int i = 0; i < dest.stairs.Length; i++)
            {
                if (dest.stairs[i] != null && dest.stairs[i].id == st.targetId)
                {
                    target = dest.stairs[i];
                    break;
                }
            }
        }
        if (target == null)
        {
            Debug.LogWarning($"[DeceitStairManager] Stair id {st.id} ({kind}) target id {st.targetId} not found on level {st.targetLevel}.");
            return;
        }

        int destTileX, destTileY;
        float destYaw;
        DestArrival(dest, target, out destTileX, out destTileY, out destYaw);
        int destUwLevel = st.targetLevel + 1; // sidecar index → 1-based engine level

        Debug.Log($"[DeceitStairManager] Stair id {st.id} ({kind}) → level {destUwLevel} tile ({destTileX},{destTileY}) yaw {destYaw}.");
        LevelLoader.sLevelLoader.ChangeLevel(destUwLevel, destTileX, destTileY, destYaw);
    }

    // True when player tile (px,py) is the single stairway wall tile for stair st (up/down).
    // Mirrors the wall-paint formula in DeceitLoader.BuildFromSidecar.
    private static bool OnStairEdge(DeceitLoader.DeceitLevel sc, DeceitLoader.DeceitStair st, int px, int py)
    {
        int uxBase = st.x * DeceitLoader.TilesPerCell;
        int uyBase = (sc.height - 1 - st.y) * DeceitLoader.TilesPerCell; // N/S flip
        int c = DeceitLoader.TilesPerCell / 2;
        string side = st.side != null ? st.side.ToUpperInvariant() : "N";
        int ex, ey;
        if (side == "N")      { ex = uxBase + c;                              ey = uyBase + DeceitLoader.TilesPerCell - 1; }
        else if (side == "S") { ex = uxBase + c;                              ey = uyBase; }
        else if (side == "W") { ex = uxBase;                                  ey = uyBase + c; }
        else                  { ex = uxBase + DeceitLoader.TilesPerCell - 1;  ey = uyBase + c; } // "E"
        return px == ex && py == ey;
    }

    // Where the player lands after arriving at destination stair `target`: one tile INTO the
    // room from the stairway wall, centred on the opening, facing away from the wall (into the
    // room), so they appear to step out of the destination stairway.
    private static void DestArrival(DeceitLoader.DeceitLevel dest, DeceitLoader.DeceitStair target,
                                    out int tileX, out int tileY, out float yaw)
    {
        int uxBase = target.x * DeceitLoader.TilesPerCell;
        int uyBase = (dest.height - 1 - target.y) * DeceitLoader.TilesPerCell; // N/S flip
        int c = DeceitLoader.TilesPerCell / 2;
        string side = target.side != null ? target.side.ToUpperInvariant() : "N";
        if (side == "N")      { tileX = uxBase + c;                              tileY = uyBase + DeceitLoader.TilesPerCell - 2; yaw = 180f; } // step south, face south
        else if (side == "S") { tileX = uxBase + c;                              tileY = uyBase + 1;                             yaw = 0f; }   // step north, face north
        else if (side == "W") { tileX = uxBase + 1;                              tileY = uyBase + c;                             yaw = 90f; }  // step east, face east
        else                  { tileX = uxBase + DeceitLoader.TilesPerCell - 2;  tileY = uyBase + c;                             yaw = 270f; } // "E": step west, face west
    }
}
