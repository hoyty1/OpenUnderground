const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Deceit Map Editor - OpenUnderground',
    backgroundColor: '#141414'
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // win.webContents.openDevTools();
}

// --- Native dialogs live in the main process; the renderer asks for a path via IPC,
// --- then does the actual file read/write itself with the 'fs' module (nodeIntegration).
ipcMain.handle('dialog:openDng', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Load DECEIT.DNG as a starting point',
    properties: ['openFile'],
    filters: [{ name: 'Deceit dungeon', extensions: ['DNG', 'dng'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:saveDng', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Save map (writes DECEIT.DNG + DECEIT.map.json)',
    defaultPath: 'DECEIT.DNG',
    filters: [{ name: 'Deceit dungeon', extensions: ['DNG', 'dng'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
