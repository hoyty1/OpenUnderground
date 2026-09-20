using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Runtime staircase driver for Deceit mode.
///
/// Replicates the base-game stair mechanic (a MoveTrigger linked to a TeleportTrap that
/// calls LevelLoader.ChangeLevel) with a single persistent singleton instead of a pair of
/// per-stair objects. Each frame it reads the current sidecar level's staircases (authored
/// in the map editor) and checks whether the player is standing on a stair's centre tile:
///
///   • "down" / "up" → LevelLoader.ChangeLevel(targetLevel+1, destTileX, destTileY),
///                     landing the player on the linked destination stair.
///   • "exit"        → returns to the World scene (leave the dungeon).
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
            int stx = st.x * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2;
            int sty = (sc.height - 1 - st.y) * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2; // N/S flip
            if (px == stx && py == sty)
            {
                onStair = st;
                break;
            }
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

        int destTileX = target.x * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2;
        int destTileY = (dest.height - 1 - target.y) * DeceitLoader.TilesPerCell + DeceitLoader.TilesPerCell / 2; // N/S flip
        int destUwLevel = st.targetLevel + 1; // sidecar index → 1-based engine level

        Debug.Log($"[DeceitStairManager] Stair id {st.id} ({kind}) → level {destUwLevel} tile ({destTileX},{destTileY}).");
        LevelLoader.sLevelLoader.ChangeLevel(destUwLevel, destTileX, destTileY);
    }
}
