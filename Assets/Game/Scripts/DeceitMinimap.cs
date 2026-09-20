using System.IO;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Runtime mini-map for Deceit mode.
///
/// Reads the DECEIT.map.json sidecar (via DeceitLoader) so it draws the SAME geometry
/// the engine actually builds — arbitrary per-level dimensions, floor/empty/wall cells,
/// fountains and the painted spawn point. Falls back to the legacy 8×8 DECEIT.DNG only
/// for levels that have no sidecar entry.
///
/// A yellow marker tracks the player's cell and updates every frame. The overlay sits in
/// the top-left corner and rebuilds its texture whenever the level (or its size) changes.
///
/// Usage: call DeceitMinimap.Ensure() once after the Deceit level loads.
/// </summary>
public class DeceitMinimap : MonoBehaviour
{
    // ── layout ────────────────────────────────────────────────────────────
    private const int Border      = 4;    // pixel border around the grid
    private const int MaxMapPixels = 220;  // longest edge of the drawn map (auto-scales cells)
    private const int MinPixelScale = 3;   // smallest screen pixels per cell
    private const int MaxPixelScale = 12;  // largest screen pixels per cell

    // ── cell colours ──────────────────────────────────────────────────────
    private static readonly Color32 ColWall     = new Color32( 18,  18,  18, 255);
    private static readonly Color32 ColEmpty    = new Color32( 28,  28,  28, 255); // unpainted void
    private static readonly Color32 ColPassage  = new Color32( 72,  72,  72, 255); // floor
    private static readonly Color32 ColLadderUp = new Color32(  0, 220, 220, 255); // cyan (DNG)
    private static readonly Color32 ColLadderDn = new Color32( 50,  80, 220, 255); // blue (DNG)
    private static readonly Color32 ColDoor     = new Color32(255, 165,   0, 255); // amber (DNG)
    private static readonly Color32 ColSpecial  = new Color32(200,   0, 200, 255); // magenta (DNG)
    private static readonly Color32 ColFountain = new Color32(110, 211, 255, 255); // light blue
    private static readonly Color32 ColSpawn    = new Color32(124, 252,   0, 255); // green
    private static readonly Color32 ColPlayer   = new Color32(255, 240,   0, 255); // yellow
    private static readonly Color32 ColBg       = new Color32( 10,  10,  10, 200);

    // ── singleton ─────────────────────────────────────────────────────────
    private static DeceitMinimap _instance;

    /// <summary>
    /// Create the minimap overlay if it doesn't exist yet.
    /// Safe to call multiple times; only one instance is ever created.
    /// </summary>
    public static void Ensure()
    {
        if (_instance != null) return;
        GameObject host = new GameObject("DeceitMinimap");
        DontDestroyOnLoad(host);
        _instance = host.AddComponent<DeceitMinimap>();
        _instance.Build();
    }

    // ── instance state ────────────────────────────────────────────────────
    private RawImage      _mapImage;
    private RectTransform _mapRt;
    private RectTransform _bgRt;
    private Texture2D     _tex;
    private byte[]        _dng;

    // current level geometry (from sidecar, or DNG fallback)
    private int    _gridW = 8, _gridH = 8;
    private int    _pixelScale = 10;
    private int    _texW, _texH;
    private int[]  _cells;                         // sidecar cells (null => DNG path)
    private DeceitLoader.DeceitPoint[] _fountains; // sidecar fountains (may be null)
    private DeceitLoader.DeceitPoint   _spawn;     // sidecar spawn (may be null)

    private int _lastLevel = -1;
    private int _lastCellX = -1;
    private int _lastCellZ = -1;

    // ── setup ─────────────────────────────────────────────────────────────
    private void Build()
    {
        // Legacy DNG kept only as a fallback for levels with no sidecar entry.
        string dngPath = Path.Combine(Application.streamingAssetsPath, "DECEIT.DNG");
        if (File.Exists(dngPath))
            _dng = File.ReadAllBytes(dngPath);

        // Canvas (screen-space, drawn on top of everything)
        Canvas canvas = gameObject.AddComponent<Canvas>();
        canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 100;
        gameObject.AddComponent<CanvasScaler>();
        gameObject.AddComponent<GraphicRaycaster>();

        // Semi-transparent background panel (resized per level in RebuildForLevel)
        GameObject bgGo = new GameObject("MinimapBg");
        bgGo.transform.SetParent(canvas.transform, false);
        Image bg = bgGo.AddComponent<Image>();
        bg.color = new Color(0f, 0f, 0f, 0.6f);
        _bgRt = bgGo.GetComponent<RectTransform>();
        _bgRt.anchorMin        = _bgRt.anchorMax = new Vector2(0f, 1f); // top-left anchor
        _bgRt.pivot            = new Vector2(0f, 1f);
        _bgRt.anchoredPosition = new Vector2(10f, -10f);              // 10px in from left/top

        // Map texture image centred inside the panel
        GameObject mapGo = new GameObject("MinimapTex");
        mapGo.transform.SetParent(bgGo.transform, false);
        _mapImage = mapGo.AddComponent<RawImage>();
        _mapRt = mapGo.GetComponent<RectTransform>();
        _mapRt.anchorMin        = _mapRt.anchorMax = new Vector2(0.5f, 0.5f);
        _mapRt.pivot            = new Vector2(0.5f, 0.5f);
        _mapRt.anchoredPosition = Vector2.zero;

        int level = (LevelLoader.sLevelLoader != null) ? LevelLoader.sLevelLoader.loadedLevel : 1;
        _lastLevel = level;
        RebuildForLevel(level);
        DrawMap();
    }

    // ── MonoBehaviour ────────────────────────────────────────────────────
    private void Update()
    {
        if (LevelLoader.sLevelLoader == null) return;

        int level = LevelLoader.sLevelLoader.loadedLevel;
        bool levelChanged = (level != _lastLevel);
        if (levelChanged)
        {
            _lastLevel = level;
            _lastCellX = _lastCellZ = -1;
            RebuildForLevel(level);
        }

        // Compute current player cell (clamped to this level's grid)
        int cx = _lastCellX;
        int cz = _lastCellZ;
        if (PlayerObject.Player != null)
        {
            Vector3 pos  = PlayerObject.Player.transform.position;
            float cellSz = DeceitLoader.TilesPerCell * LevelLoader.xzScale;
            cx = Mathf.Clamp(Mathf.FloorToInt(pos.x / cellSz), 0, _gridW - 1);
            cz = Mathf.Clamp(Mathf.FloorToInt(pos.z / cellSz), 0, _gridH - 1);
        }

        if (levelChanged || cx != _lastCellX || cz != _lastCellZ)
        {
            _lastCellX = cx;
            _lastCellZ = cz;
            DrawMap();
        }
    }

    private void OnDestroy()
    {
        if (_instance == this) _instance = null;
    }

    // ── per-level setup ───────────────────────────────────────────────────
    /// <summary>
    /// Loads the geometry for the given level from the sidecar (preferred) or DNG, computes
    /// the pixel scale and (re)allocates the texture/rects to fit the level's dimensions.
    /// </summary>
    private void RebuildForLevel(int level)
    {
        int deceitIdx = level - 1;
        DeceitLoader.DeceitLevel sc = DeceitLoader.GetSidecarLevel(deceitIdx);

        if (sc != null && sc.cells != null && sc.width > 0 && sc.height > 0
            && sc.cells.Length >= sc.width * sc.height)
        {
            _gridW     = sc.width;
            _gridH     = sc.height;
            _cells     = sc.cells;
            _fountains = sc.fountains;
            _spawn     = sc.spawn;
        }
        else
        {
            _gridW     = 8;
            _gridH     = 8;
            _cells     = null;   // DNG fallback
            _fountains = null;
            _spawn     = null;
        }

        int maxDim = Mathf.Max(_gridW, _gridH);
        _pixelScale = Mathf.Clamp(MaxMapPixels / Mathf.Max(1, maxDim), MinPixelScale, MaxPixelScale);

        int newTexW = _gridW * _pixelScale + Border * 2;
        int newTexH = _gridH * _pixelScale + Border * 2;
        if (_tex == null || newTexW != _texW || newTexH != _texH)
        {
            _texW = newTexW;
            _texH = newTexH;
            if (_tex != null) Destroy(_tex);
            _tex = new Texture2D(_texW, _texH, TextureFormat.RGBA32, false)
            {
                filterMode = FilterMode.Point,
                wrapMode   = TextureWrapMode.Clamp
            };
            _mapImage.texture = _tex;
            _mapRt.sizeDelta  = new Vector2(_texW, _texH);
            _bgRt.sizeDelta   = new Vector2(_texW + Border * 2, _texH + Border * 2);
        }
    }

    // ── rendering ────────────────────────────────────────────────────────
    private void DrawMap()
    {
        if (_tex == null) return;

        Color32[] pixels = new Color32[_texW * _texH];
        for (int i = 0; i < pixels.Length; i++)
            pixels[i] = ColBg;

        int level       = (_lastLevel > 0) ? _lastLevel : 1;
        int levelOffset = (level - 1) * 512;

        for (int row = 0; row < _gridH; row++)
        {
            for (int col = 0; col < _gridW; col++)
            {
                Color32 color;
                if (_cells != null)
                {
                    int code = _cells[row * _gridW + col]; // 0=empty,1=floor,2=wall
                    color = (code == 1) ? ColPassage : (code == 2 ? ColWall : ColEmpty);
                }
                else if (_dng != null)
                {
                    int byteIdx = levelOffset + row * 8 + col;
                    color = (byteIdx < _dng.Length) ? NibbleToColor((_dng[byteIdx] >> 4) & 0xF) : ColWall;
                }
                else
                {
                    color = ColWall;
                }

                FillCell(pixels, col, row, color);
            }
        }

        // Fountains (sidecar only)
        if (_fountains != null)
        {
            foreach (DeceitLoader.DeceitPoint f in _fountains)
            {
                if (f == null) continue;
                if (f.x < 0 || f.x >= _gridW || f.y < 0 || f.y >= _gridH) continue;
                FillCell(pixels, f.x, f.y, ColFountain);
            }
        }

        // Spawn point (sidecar only)
        if (_spawn != null && _spawn.x >= 0 && _spawn.x < _gridW && _spawn.y >= 0 && _spawn.y < _gridH)
        {
            FillCell(pixels, _spawn.x, _spawn.y, ColSpawn);
        }

        // Player marker centred on the player cell
        if (_lastCellX >= 0 && _lastCellZ >= 0 && _lastCellX < _gridW && _lastCellZ < _gridH)
        {
            int mark = Mathf.Max(2, _pixelScale / 2);
            int px = Border + _lastCellX * _pixelScale + _pixelScale / 2 - mark / 2;
            int py = Border + (_gridH - 1 - _lastCellZ) * _pixelScale + _pixelScale / 2 - mark / 2;
            for (int dy = 0; dy < mark; dy++)
            {
                for (int dx = 0; dx < mark; dx++)
                {
                    int idx = (py + dy) * _texW + (px + dx);
                    if (idx >= 0 && idx < pixels.Length)
                        pixels[idx] = ColPlayer;
                }
            }
        }

        _tex.SetPixels32(pixels);
        _tex.Apply(false);
    }

    /// <summary>Fills one grid cell (north-up: row 0 drawn at the bottom) leaving a 1px gap.</summary>
    private void FillCell(Color32[] pixels, int col, int row, Color32 color)
    {
        int texY = Border + (_gridH - 1 - row) * _pixelScale;
        int texX = Border + col * _pixelScale;
        int inset = (_pixelScale >= 4) ? 1 : 0; // keep a separating border only when cells are big enough
        for (int dy = inset; dy < _pixelScale - inset; dy++)
        {
            int yy = texY + dy;
            if (yy < 0 || yy >= _texH) continue;
            for (int dx = inset; dx < _pixelScale - inset; dx++)
            {
                int xx = texX + dx;
                if (xx < 0 || xx >= _texW) continue;
                pixels[yy * _texW + xx] = color;
            }
        }
    }

    private static Color32 NibbleToColor(int nibble)
    {
        switch (nibble)
        {
            case 0x0: return ColWall;
            case 0x1: return ColLadderUp;   // ladder up
            case 0x2: return ColLadderDn;   // ladder down
            case 0xC: return ColDoor;       // door
            case 0xD: return ColSpecial;    // special room
            default:  return ColPassage;    // 0x3-0xB, 0xE, 0xF = various passable types
        }
    }
}
