const { useState, useEffect, useRef, useCallback } = React;
const fs = require('fs');
const { dialog } = require('electron').remote || require('@electron/remote');

// Cell type constants
const CELL_TYPES = {
  WALL: 0x0,
  LADDER_UP: 0x1,
  LADDER_DOWN: 0x2,
  PASSAGE: 0xF,
  DOOR: 0xC,
  SPECIAL: 0xD
};

const CELL_COLORS = {
  [CELL_TYPES.WALL]: '#111111',
  [CELL_TYPES.LADDER_UP]: '#00dddd',
  [CELL_TYPES.LADDER_DOWN]: '#3366ff',
  [CELL_TYPES.PASSAGE]: '#555555',
  [CELL_TYPES.DOOR]: '#ffaa00',
  [CELL_TYPES.SPECIAL]: '#dd00dd'
};

const CELL_ICONS = {
  [CELL_TYPES.WALL]: '',
  [CELL_TYPES.LADDER_UP]: '🪜↑',
  [CELL_TYPES.LADDER_DOWN]: '🪜↓',
  [CELL_TYPES.PASSAGE]: '',
  [CELL_TYPES.DOOR]: '🚪',
  [CELL_TYPES.SPECIAL]: '⭐'
};

const CELL_NAMES = {
  [CELL_TYPES.WALL]: 'Wall',
  [CELL_TYPES.LADDER_UP]: 'Ladder Up',
  [CELL_TYPES.LADDER_DOWN]: 'Ladder Down',
  [CELL_TYPES.PASSAGE]: 'Passage',
  [CELL_TYPES.DOOR]: 'Door',
  [CELL_TYPES.SPECIAL]: 'Special Room'
};

// Level 1 default data (from DECEIT.DNG analysis)
const LEVEL_1_DEFAULT = [
  0xF0, 0xF0, 0xF0, 0x00, 0xF0, 0xF0, 0xF0, 0x00,
  0xF0, 0x10, 0x00, 0x00, 0xC0, 0x00, 0xF0, 0x00,
  0xF0, 0x00, 0xF0, 0xF0, 0xF0, 0x00, 0xF0, 0x00,
  0x00, 0x00, 0xF0, 0xD0, 0x00, 0x00, 0xF0, 0x00,
  0xF0, 0xC0, 0xF0, 0x00, 0xF0, 0xF0, 0xF0, 0xF0,
  0xF0, 0x00, 0x00, 0x00, 0xF0, 0x20, 0x00, 0x90,
  0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0x00, 0xF0, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xF0, 0x90, 0x00, 0x00
];

const SPAWN_CELL = { col: 4, row: 4 };

function DeceitMapEditor() {
  const [levels, setLevels] = useState(() => {
    const init = Array(9).fill(null).map(() => 
      Array(64).fill(CELL_TYPES.WALL)
    );
    // Load Level 1 default
    for (let i = 0; i < 64; i++) {
      init[0][i] = (LEVEL_1_DEFAULT[i] >> 4) & 0xF;
    }
    return init;
  });
  
  const [currentLevel, setCurrentLevel] = useState(0);
  const [selectedCell, setSelectedCell] = useState(null);
  const [showRegions, setShowRegions] = useState(false);
  const [wrapAround, setWrapAround] = useState(true);
  const [regions, setRegions] = useState([]);
  const [loadedFile, setLoadedFile] = useState(null);
  const fileInputRef = useRef(null);

  const currentGrid = levels[currentLevel];

  // BFS flood-fill for connectivity analysis
  const computeRegions = useCallback(() => {
    const visited = new Set();
    const regionList = [];
    
    for (let i = 0; i < 64; i++) {
      const cellType = currentGrid[i];
      if (cellType !== CELL_TYPES.WALL && !visited.has(i)) {
        const region = [];
        const queue = [i];
        visited.add(i);
        
        while (queue.length > 0) {
          const idx = queue.shift();
          region.push(idx);
          
          const row = Math.floor(idx / 8);
          const col = idx % 8;
          
          // Check all 4 neighbors (with optional wrap)
          const neighbors = [
            { dr: -1, dc: 0 },  // north
            { dr: 1, dc: 0 },   // south
            { dr: 0, dc: -1 },  // west
            { dr: 0, dc: 1 }    // east
          ];
          
          for (const { dr, dc } of neighbors) {
            let nr = row + dr;
            let nc = col + dc;
            
            // Wrap-around logic
            if (wrapAround) {
              nr = (nr + 8) % 8;
              nc = (nc + 8) % 8;
            } else {
              if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) continue;
            }
            
            const nidx = nr * 8 + nc;
            const ntype = currentGrid[nidx];
            
            if (ntype !== CELL_TYPES.WALL && !visited.has(nidx)) {
              visited.add(nidx);
              queue.push(nidx);
            }
          }
        }
        
        regionList.push(region);
      }
    }
    
    setRegions(regionList);
  }, [currentGrid, wrapAround]);

  useEffect(() => {
    if (showRegions) {
      computeRegions();
    }
  }, [showRegions, wrapAround, currentGrid, computeRegions]);

  const getRegionForCell = (idx) => {
    for (let i = 0; i < regions.length; i++) {
      if (regions[i].includes(idx)) return i + 1;
    }
    return null;
  };

  const getRegionColor = (regionNum) => {
    if (!regionNum) return null;
    const hue = (regionNum * 137) % 360; // golden angle distribution
    return `hsla(${hue}, 70%, 50%, 0.3)`;
  };

  const cycleCellType = (idx) => {
    const current = currentGrid[idx];
    const cycle = [
      CELL_TYPES.WALL,
      CELL_TYPES.PASSAGE,
      CELL_TYPES.DOOR,
      CELL_TYPES.LADDER_UP,
      CELL_TYPES.LADDER_DOWN,
      CELL_TYPES.SPECIAL
    ];
    const currentIdx = cycle.indexOf(current);
    const next = cycle[(currentIdx + 1) % cycle.length];
    
    const newGrid = [...currentGrid];
    newGrid[idx] = next;
    
    const newLevels = [...levels];
    newLevels[currentLevel] = newGrid;
    setLevels(newLevels);
  };

  const setWall = (idx) => {
    const newGrid = [...currentGrid];
    newGrid[idx] = CELL_TYPES.WALL;
    
    const newLevels = [...levels];
    newLevels[currentLevel] = newGrid;
    setLevels(newLevels);
  };

  const handleCellClick = (idx, isRightClick) => {
    setSelectedCell(idx);
    if (isRightClick) {
      setWall(idx);
    } else {
      cycleCellType(idx);
    }
  };

  const handleKeyDown = useCallback((e) => {
    if (selectedCell === null) return;
    
    const newGrid = [...currentGrid];
    let moved = false;
    let newIdx = selectedCell;
    
    const row = Math.floor(selectedCell / 8);
    const col = selectedCell % 8;
    
    switch (e.key.toLowerCase()) {
      case 'w':
        newGrid[selectedCell] = CELL_TYPES.WALL;
        break;
      case 'p':
        newGrid[selectedCell] = CELL_TYPES.PASSAGE;
        break;
      case 'd':
        newGrid[selectedCell] = CELL_TYPES.DOOR;
        break;
      case 'u':
        newGrid[selectedCell] = CELL_TYPES.LADDER_UP;
        break;
      case 'l':
        newGrid[selectedCell] = CELL_TYPES.LADDER_DOWN;
        break;
      case 's':
        newGrid[selectedCell] = CELL_TYPES.SPECIAL;
        break;
      case 'arrowup':
        if (row > 0) {
          newIdx = (row - 1) * 8 + col;
          moved = true;
        }
        e.preventDefault();
        break;
      case 'arrowdown':
        if (row < 7) {
          newIdx = (row + 1) * 8 + col;
          moved = true;
        }
        e.preventDefault();
        break;
      case 'arrowleft':
        if (col > 0) {
          newIdx = row * 8 + (col - 1);
          moved = true;
        }
        e.preventDefault();
        break;
      case 'arrowright':
        if (col < 7) {
          newIdx = row * 8 + (col + 1);
          moved = true;
        }
        e.preventDefault();
        break;
      default:
        return;
    }
    
    if (moved) {
      setSelectedCell(newIdx);
    } else {
      const newLevels = [...levels];
      newLevels[currentLevel] = newGrid;
      setLevels(newLevels);
    }
  }, [selectedCell, currentGrid, currentLevel, levels]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOpenFile = async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'DNG Files', extensions: ['DNG', 'dng'] }]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      const buffer = fs.readFileSync(filePath);
      
      if (buffer.length < 9 * 512) {
        alert('Invalid DECEIT.DNG file: too small');
        return;
      }
      
      const newLevels = [];
      for (let lvl = 0; lvl < 9; lvl++) {
        const offset = lvl * 512;
        const grid = [];
        for (let i = 0; i < 64; i++) {
          const cellByte = buffer[offset + i];
          grid.push((cellByte >> 4) & 0xF);
        }
        newLevels.push(grid);
      }
      
      setLevels(newLevels);
      setLoadedFile(filePath);
    }
  };

  const handleExport = async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'DECEIT.DNG',
      filters: [{ name: 'DNG Files', extensions: ['DNG', 'dng'] }]
    });
    
    if (!result.canceled && result.filePath) {
      const buffer = Buffer.alloc(9 * 512);
      
      // If we loaded a file, preserve original data beyond the first 64 bytes
      if (loadedFile) {
        const original = fs.readFileSync(loadedFile);
        original.copy(buffer);
      }
      
      // Write edited grids (first 64 bytes of each level)
      for (let lvl = 0; lvl < 9; lvl++) {
        const offset = lvl * 512;
        for (let i = 0; i < 64; i++) {
          const cellType = levels[lvl][i];
          buffer[offset + i] = (cellType << 4) | 0x0; // high nibble = type, low = 0
        }
      }
      
      fs.writeFileSync(result.filePath, buffer);
      alert('Exported successfully!');
    }
  };

  const spawnIdx = SPAWN_CELL.row * 8 + SPAWN_CELL.col;
  const spawnRegion = showRegions ? getRegionForCell(spawnIdx) : null;

  return (
    <div className="app">
      <div className="header">
        <h1>Deceit Map Editor - OpenUnderground</h1>
        <div className="header-controls">
          <button className="btn" onClick={handleOpenFile}>Open DECEIT.DNG</button>
          <button className="btn btn-primary" onClick={handleExport}>Export DECEIT.DNG</button>
        </div>
      </div>
      
      <div className="content">
        <div className="sidebar">
          <div className="sidebar-section">
            <h2>Cell Types</h2>
            {Object.entries(CELL_TYPES).map(([name, type]) => (
              <div key={type} className="legend-item">
                <div 
                  className="legend-color"
                  style={{ background: CELL_COLORS[type] }}
                >
                  <div style={{ textAlign: 'center', lineHeight: '32px', fontSize: '18px' }}>
                    {CELL_ICONS[type]}
                  </div>
                </div>
                <div className="legend-info">
                  <div className="legend-name">{CELL_NAMES[type]}</div>
                  <div className="legend-key">0x{type.toString(16).toUpperCase()}</div>
                </div>
              </div>
            ))}
          </div>
          
          {selectedCell !== null && (
            <div className="sidebar-section">
              <h2>Cell Info</h2>
              <div className="cell-info-grid">
                <div className="cell-info-label">Position:</div>
                <div className="cell-info-value">
                  ({selectedCell % 8}, {Math.floor(selectedCell / 8)})
                </div>
                
                <div className="cell-info-label">Type:</div>
                <div className="cell-info-value">
                  {CELL_NAMES[currentGrid[selectedCell]]}
                </div>
                
                {showRegions && (
                  <>
                    <div className="cell-info-label">Region:</div>
                    <div className="cell-info-value">
                      {getRegionForCell(selectedCell) || 'None (wall)'}
                    </div>
                    
                    {spawnRegion && (
                      <>
                        <div className="cell-info-label">From Spawn:</div>
                        <div className="cell-info-value">
                          {getRegionForCell(selectedCell) === spawnRegion ? 'Yes' : 'No'}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          
          <div className="sidebar-section">
            <h2>View Options</h2>
            <div className="toggle-group">
              <div className="toggle-item">
                <div className="toggle-label">Show Regions</div>
                <div 
                  className={`toggle-switch ${showRegions ? 'active' : ''}`}
                  onClick={() => setShowRegions(!showRegions)}
                >
                  <div className="toggle-slider" />
                </div>
              </div>
              
              <div className="toggle-item">
                <div className="toggle-label">Wrap Around</div>
                <div 
                  className={`toggle-switch ${wrapAround ? 'active' : ''}`}
                  onClick={() => setWrapAround(!wrapAround)}
                >
                  <div className="toggle-slider" />
                </div>
              </div>
            </div>
          </div>
          
          <div className="sidebar-section">
            <h2>Shortcuts</h2>
            <ul className="shortcuts-list">
              <li>
                <span>Wall</span>
                <span className="shortcut-key">W</span>
              </li>
              <li>
                <span>Passage</span>
                <span className="shortcut-key">P</span>
              </li>
              <li>
                <span>Door</span>
                <span className="shortcut-key">D</span>
              </li>
              <li>
                <span>Ladder Up</span>
                <span className="shortcut-key">U</span>
              </li>
              <li>
                <span>Ladder Down</span>
                <span className="shortcut-key">L</span>
              </li>
              <li>
                <span>Special</span>
                <span className="shortcut-key">S</span>
              </li>
              <li>
                <span>Navigate</span>
                <span className="shortcut-key">Arrows</span>
              </li>
              <li>
                <span>Cycle Type</span>
                <span className="shortcut-key">Click</span>
              </li>
              <li>
                <span>Set Wall</span>
                <span className="shortcut-key">Right-Click</span>
              </li>
            </ul>
          </div>
        </div>
        
        <div className="main-area">
          <div className="toolbar">
            {Array.from({ length: 9 }, (_, i) => (
              <button
                key={i}
                className={`level-tab ${currentLevel === i ? 'active' : ''}`}
                onClick={() => {
                  setCurrentLevel(i);
                  setSelectedCell(null);
                }}
              >
                Level {i + 1}
              </button>
            ))}
          </div>
          
          <div className="canvas-container">
            <div className="grid-wrapper">
              <div className="grid">
                {currentGrid.map((cellType, idx) => {
                  const row = Math.floor(idx / 8);
                  const col = idx % 8;
                  const isSpawn = col === SPAWN_CELL.col && row === SPAWN_CELL.row;
                  const region = showRegions ? getRegionForCell(idx) : null;
                  const regionColor = region ? getRegionColor(region) : null;
                  
                  return (
                    <div
                      key={idx}
                      className={`cell ${selectedCell === idx ? 'selected' : ''}`}
                      style={{
                        background: regionColor || CELL_COLORS[cellType],
                        color: '#fff'
                      }}
                      onClick={() => handleCellClick(idx, false)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        handleCellClick(idx, true);
                      }}
                    >
                      {CELL_ICONS[cellType]}
                      {showRegions && region && (
                        <div className="cell-region-label">R{region}</div>
                      )}
                      {isSpawn && <div className="spawn-marker">⭐</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.render(<DeceitMapEditor />, document.getElementById('root'));
