// Electron main: ローカル専用の執筆アプリ。リモートコンテンツは一切読まない。
// webSecurity:false / nodeIntegration:true は file:// 上の ES module + IPC レス fs 利用の割り切り
// (完全ローカル・自分の原稿のみという前提でのみ正当)。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 同梱ローカルLLM(llama-server + TinySwallow-1.5B)。変換候補の審査員専用
let llmProc = null;
function startLlm() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname;
  const dir = path.join(base, 'llm');
  const bin = process.platform === 'win32'
    ? path.join(dir, 'win', 'llama-server.exe')
    : path.join(dir, 'mac', 'llama-server');
  const model = path.join(dir, 'model.gguf');
  if (!fs.existsSync(bin) || !fs.existsSync(model)) return;
  llmProc = spawn(bin, ['-m', model, '--port', '18434', '-c', '1024', '--log-disable'], { stdio: 'ignore' });
  llmProc.on('error', () => (llmProc = null));
}

// 自動保存先: 書類/novel-editor/(ユーザから見える実ファイル)
ipcMain.handle('save-file', (e, { name, content }) => {
  const dir = path.join(app.getPath('documents'), 'novel-editor');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'novel-editor',
    backgroundColor: '#fafaf7',
    icon: path.join(__dirname, 'build', 'icon-1024.png'),
    webPreferences: { webSecurity: false, nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'build', 'icon-1024.png'));
  startLlm();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { llmProc?.kill(); } catch {} });
