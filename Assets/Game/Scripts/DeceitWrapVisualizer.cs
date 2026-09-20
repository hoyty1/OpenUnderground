using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// Seamless-wrap renderer for Deceit mode ("step 2" of the wrap work).
///
/// The player's position already wraps around a looping level's edges (the torus reposition
/// in PlayerObject) but, on its own, that reposition is an invisible jump: the moment before
/// the player crosses the east edge they see empty void beyond it, then snap to the west edge.
///
/// This component removes the visible seam WITHOUT any teleport flash by rendering exact,
/// collider-free copies ("ghosts") of the whole level mesh in the eight neighbouring loop
/// positions (±levelWidth, ±levelHeight). As the player walks toward any looping edge they
/// see the opposite side of the level already drawn continuously across the seam; because the
/// ghost is a pixel-exact translation of the real geometry, the loop-period reposition that
/// follows is imperceptible. This is the axis-preserving "render destination geometry adjacent
/// + reposition by loop-period" approach — no discrete teleport, no load, no rotation.
///
/// Only looping levels get ghosts: a level is treated as looping when at least one cell on its
/// outer border is floor (an open edge). Fully-walled, non-looping levels such as Deceit level 1
/// get none, so large hand-drawn levels are unaffected.
///
/// The ghosts are rebuilt whenever the loaded level changes and are visual-only (no colliders),
/// so they never interfere with movement, the wrap reposition, or the stair manager.
///
/// Usage: call DeceitWrapVisualizer.Ensure() once after the Deceit game starts.
/// </summary>
public class DeceitWrapVisualizer : MonoBehaviour
{
    private static DeceitWrapVisualizer _instance;

    /// <summary>Create the wrap visualizer once. Safe to call repeatedly.</summary>
    public static void Ensure()
    {
        if (_instance != null) return;
        GameObject host = new GameObject("DeceitWrapVisualizer");
        DontDestroyOnLoad(host);
        _instance = host.AddComponent<DeceitWrapVisualizer>();
    }

    private int _builtLevel = -1;                    // loadedLevel the ghosts were built for (-1 = none)
    private readonly List<GameObject> _ghosts = new List<GameObject>();

    private void Update()
    {
        LevelLoader ll = LevelLoader.sLevelLoader;
        if (ll == null || !ll.deceitMode)
        {
            if (_ghosts.Count > 0) ClearGhosts();
            _builtLevel = -1;
            return;
        }

        if (ll.loadedLevel == _builtLevel) return; // already current
        Rebuild(ll.loadedLevel);
    }

    private void ClearGhosts()
    {
        for (int i = 0; i < _ghosts.Count; i++)
        {
            if (_ghosts[i] != null) Destroy(_ghosts[i]);
        }
        _ghosts.Clear();
    }

    private void Rebuild(int level)
    {
        ClearGhosts();

        Level lv = LevelLoader.GetLevel();
        if (lv == null || lv.geo == null || lv.geo.gameObject == null)
        {
            // Geometry not built yet (e.g. mid level-change). Leave _builtLevel stale so we retry.
            _builtLevel = -1;
            return;
        }

        // Commit to this level; only looping levels actually get ghosts.
        _builtLevel = level;
        if (!LevelLoops(level)) return;

        float worldWidth = lv.Width * LevelLoader.xzScale;
        float worldHeight = lv.Height * LevelLoader.xzScale;

        // The level mesh lives at world origin (vertices are absolute), so a ghost is just the
        // same shared meshes rendered at a whole-level offset.
        MeshFilter[] filters = lv.geo.gameObject.GetComponentsInChildren<MeshFilter>();
        if (filters == null || filters.Length == 0) return;

        for (int dz = -1; dz <= 1; dz++)
        {
            for (int dx = -1; dx <= 1; dx++)
            {
                if (dx == 0 && dz == 0) continue; // the real level
                Vector3 offset = new Vector3(dx * worldWidth, 0f, dz * worldHeight);
                GameObject ghost = new GameObject($"DeceitWrapGhost_{dx}_{dz}");
                ghost.transform.position = offset;

                for (int f = 0; f < filters.Length; f++)
                {
                    MeshFilter mf = filters[f];
                    if (mf == null || mf.sharedMesh == null) continue;
                    MeshRenderer srcMr = mf.GetComponent<MeshRenderer>();
                    if (srcMr == null) continue;

                    GameObject part = new GameObject("GhostMesh");
                    part.transform.SetParent(ghost.transform, false);
                    part.transform.localPosition = Vector3.zero; // source parts share the origin

                    MeshFilter gf = part.AddComponent<MeshFilter>();
                    gf.sharedMesh = mf.sharedMesh;

                    MeshRenderer gr = part.AddComponent<MeshRenderer>();
                    gr.sharedMaterials = srcMr.sharedMaterials;
                    gr.lightProbeUsage = 0;
                    gr.shadowCastingMode = ShadowCastingMode.Off;
                    gr.receiveShadows = false;
                }

                _ghosts.Add(ghost);
            }
        }

        Debug.Log($"[DeceitWrapVisualizer] Built seamless-wrap ghosts for level {level} ({worldWidth}×{worldHeight} world units).");
    }

    /// <summary>A level loops when any cell on its outer border is floor (an open edge).</summary>
    private static bool LevelLoops(int level)
    {
        DeceitLoader.DeceitLevel sc = DeceitLoader.GetSidecarLevel(level - 1);
        if (sc == null || sc.cells == null || sc.width <= 0 || sc.height <= 0) return false;
        int w = sc.width, h = sc.height;
        if (sc.cells.Length < w * h) return false;

        for (int x = 0; x < w; x++)
        {
            if (sc.cells[x] == 1) return true;                 // north border (row 0)
            if (sc.cells[(h - 1) * w + x] == 1) return true;   // south border (row h-1)
        }
        for (int y = 0; y < h; y++)
        {
            if (sc.cells[y * w] == 1) return true;             // west border (col 0)
            if (sc.cells[y * w + (w - 1)] == 1) return true;   // east border (col w-1)
        }
        return false;
    }
}
