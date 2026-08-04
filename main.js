const { app, BrowserWindow, session } = require('electron');
const path = require('path');

function createWindow() {
  // Completely bypass browser security limits for unhindered direct IPTV streaming
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET,HEAD,POST,OPTIONS']
      }
    });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#050914',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Disables CORS/Mixed Content blocking entirely for raw streams
    }
  });

  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});