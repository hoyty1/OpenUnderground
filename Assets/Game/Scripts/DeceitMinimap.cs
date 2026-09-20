using System.IO;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Runtime mini-map for Deceit mode.
/// Draws a colour-coded 8×8 U4 cell grid in the bottom-left corner of the
/// screen, with a yellow player-position marker that updates every frame.
///
/// Usage: call DeceitMinimap.Ensure() once after the Deceit level loads.
/// The instance survives level transitions (DontDestroyOnLoad) and
/// auto-refreshes when the loaded level or player cell changes.
/// </summary>
public class DeceitMinimap : MonoBehaviour
{
    // ── layout ────────────────────────────────────────────────────────────
    private const int CellCount  = 8;   // U4 grid dimension
    private const int PixelScale = 10;  // screen pixels per U4 cell
    private const int Border     = 4;   // pixel border around the grid
    private const int TexSize    = CellCount * PixelScale + Border * 2;

    // ── cell colours ──────────────────────────────────────────────────────
    private static readonly Color32 ColWall     = new Color32( 18,  18,  18, 255);
    private static readonly Color32 ColPassage  = new Color32( 72,  72,  72, 255);
    private static readonly Color32 ColLadderUp = new Color32(  0, 220, 220, 255); // cyan
    private static readonly Color32 ColLadderDn = new Color32( 50,  80, 220, 255); // blue
    private static readonly Color32 ColDoor     = new Color32(255, 165,   0, 255); // amber
    private static readonly Color32 ColSpecial  = new Color32(200,   0, 200, 255); // magenta
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
    private RawImage  _mapImage;
    private Texture2D _tex;
    private byte[]    _dng;
    private int       _lastLevel = -1;
    private int       _lastCellX = -1;
    private int       _lastCellZ = -1;

    // ── setup ─────────────────────────────────────────────────────────────
    private void Build()
    {
        // Pre-load the DNG data
        string dngPath = Path.Combine(Application.streamingAssetsPath, "DECEIT.DNG");
        if (File.Exists(dngPath))
            _dng = File.ReadAllBytes(dngPath);
        else
            Debug.LogWarning("[DeceitMinimap] DECEIT.DNG not found – map will show empty grid.");

        // Canvas (screen-space, drawn on top of everything)
        Canvas canvas = gameObject.AddComponent<Canvas>();
        canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 100;
        gameObject.AddComponent<CanvasScaler>();
        gameObject.AddComponent<GraphicRaycaster>();

        // Semi-transparent background panel
        int panelSize = TexSize + Border * 2;
        GameObject bgGo = new GameObject("MinimapBg");
        bgGo.transform.SetParent(canvas.transform, false);
        Image bg = bgGo.AddComponent<Image>();
        bg.color = new Color(0f, 0f, 0f, 0.6f);
        RectTransform bgRt = bgGo.GetComponent<RectTransform>();
        bgRt.anchorMin        = bgRt.anchorMax = new Vector2(0f, 1f); // top-left anchor
        bgRt.pivot            = new Vector2(0f, 1f);
        bgRt.anchoredPosition = new Vector2(10f, -10f);              // 10px in from left/top
        bgRt.sizeDelta        = new Vector2(panelSize, panelSize);

        // Map texture image centred inside the panel
        GameObject mapGo = new GameObject("MinimapTex");
        mapGo.transform.SetParent(bgGo.transform, false);
        _mapImage = mapGo.AddComponent<RawImage>();
        RectTransform mapRt = mapGo.GetComponent<RectTransform>();
        mapRt.anchorMin        = mapRt.anchorMax = new Vector2(0.5f, 0.5f);
        mapRt.pivot            = new Vector2(0.5f, 0.5f);
        mapRt.anchoredPosition = Vector2.zero;
        mapRt.sizeDelta        = new Vector2(TexSize, TexSize);

        // Pixel-art texture
        _tex = new Texture2D(TexSize, TexSize, TextureFormat.RGBA32, false)
        {
            filterMode = FilterMode.Point,
            wrapMode   = TextureWrapMode.Clamp
        };
        _mapImage.texture = _tex;

        // Draw the initial map
        if (LevelLoader.sLevelLoader != null)
            _lastLevel = LevelLoader.sLevelLoader.loadedLevel;

        DrawMap();
    }

    // ── MonoBehaviour ────────────────────────────────────────────────────
    private void Update()
    {
        if (_tex == null) return;
        if (LevelLoader.sLevelLoader == null) return;

        int level = LevelLoader.sLevelLoader.loadedLevel;
        bool levelChanged = (level != _lastLevel);
        if (levelChanged)
        {
            _lastLevel = level;
            _lastCellX = _lastCellZ = -1;
        }

        // Compute current player cell
        int cx = _lastCellX;
        int cz = _lastCellZ;
        if (PlayerObject.Player != null)
        {
            Vector3 pos  = PlayerObject.Player.transform.position;
            float cellSz = DeceitLoader.TilesPerCell * LevelLoader.xzScale;
            cx = Mathf.Clamp(Mathf.FloorToInt(pos.x / cellSz), 0, CellCount - 1);
            cz = Mathf.Clamp(Mathf.FloorToInt(pos.z / cellSz), 0, CellCount - 1);
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

    // ── rendering ────────────────────────────────────────────────────────
    private void DrawMap()
    {
        Color32[] pixels = new Color32[TexSize * TexSize];

        // Fill with background colour
        for (int i = 0; i < pixels.Length; i++)
            pixels[i] = ColBg;

        int level       = (_lastLevel > 0) ? _lastLevel : 1;
        int deceitIdx   = level - 1;
        int levelOffset = deceitIdx * 512;

        // Draw each U4 cell
        for (int row = 0; row < CellCount; row++)
        {
            for (int col = 0; col < CellCount; col++)
            {
                Color32 color = ColWall;
                if (_dng != null)
                {
                    int byteIdx = levelOffset + row * CellCount + col;
                    if (byteIdx < _dng.Length)
                    {
                        byte cell       = _dng[byteIdx];
                        int  typeNibble = (cell >> 4) & 0xF;
                        color = NibbleToColor(typeNibble);
                    }
                }

                // North-up: row 0 of the map is drawn at the bottom of the texture (flip Y).
                int texY = Border + (CellCount - 1 - row) * PixelScale;
                int texX = Border + col * PixelScale;

                for (int dy = 1; dy < PixelScale - 1; dy++)        // 1-px black border on each cell
                {
                    for (int dx = 1; dx < PixelScale - 1; dx++)
                    {
                        pixels[(texY + dy) * TexSize + (texX + dx)] = color;
                    }
                }
            }
        }

        // Player marker: 4×4 yellow square centred on the player cell
        if (_lastCellX >= 0 && _lastCellZ >= 0)
        {
            int px = Border + _lastCellX * PixelScale + PixelScale / 2 - 2;
            int py = Border + (CellCount - 1 - _lastCellZ) * PixelScale + PixelScale / 2 - 2;
            for (int dy = 0; dy < 4; dy++)
            {
                for (int dx = 0; dx < 4; dx++)
                {
                    int idx = (py + dy) * TexSize + (px + dx);
                    if (idx >= 0 && idx < pixels.Length)
                        pixels[idx] = ColPlayer;
                }
            }
        }

        _tex.SetPixels32(pixels);
        _tex.Apply(false);
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
