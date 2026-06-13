// Electron main: ローカル専用の執筆アプリ。リモートコンテンツは一切読まない。
// webSecurity:false / nodeIntegration:true は file:// 上の ES module + IPC レス fs 利用の割り切り
// (完全ローカル・自分の原稿のみという前提でのみ正当)。
const { app, BrowserWindow, ipcMain, dialog, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 同梱ローカルLLM。審査は2モデルの合議(TinySwallow-1.5B + Qwen3-4B)、採取系は賢い方(model2)
let llmProc = null, llmProc2 = null;
if (!app.requestSingleInstanceLock()) app.quit(); // 二重起動禁止(LLMポートの取り合い防止)

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
  const model2 = path.join(dir, 'model2.gguf');
  if (!fs.existsSync(model2)) return;
  llmProc2 = spawn(bin, ['-m', model2, '--port', '18437', '-c', '1024', '--log-disable'], { stdio: 'ignore' });
  llmProc2.on('error', () => (llmProc2 = null));
}
// 同梱 whisper(音声入力)。声は証拠としても保存される
let whisperProc = null;
function startWhisper() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname;
  const dir = path.join(base, 'llm');
  const bin = process.platform === 'win32'
    ? path.join(dir, 'whisper-win', 'whisper-server.exe')
    : path.join(dir, 'whisper-mac', 'whisper-server');
  const model = path.join(dir, 'whisper-small.bin');
  if (!fs.existsSync(bin) || !fs.existsSync(model)) return;
  whisperProc = spawn(bin, ['-m', model, '--port', '18436', '-l', 'ja'], { stdio: 'ignore' });
  whisperProc.on('error', () => (whisperProc = null));
}

// 自動保存先: 書類/novel-editor/(ユーザから見える実ファイル)
ipcMain.handle('save-file', (e, { name, content }) => {
  const dir = path.join(app.getPath('documents'), 'novel-editor');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
});
ipcMain.handle('append-file', (e, { name, content }) => {
  const dir = path.join(app.getPath('documents'), 'novel-editor');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.appendFileSync(p, content, 'utf8');
  return p;
});

ipcMain.handle('save-voice', (e, { name, b64 }) => {
  const dir = path.join(app.getPath('documents'), 'novel-editor', 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
});
ipcMain.handle('read-file', (e, { name }) => {
  const p = path.join(app.getPath('documents'), 'novel-editor', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});

// 作品ファイル(正本txt)の開く/書き込み
ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog({
    defaultPath: path.join(app.getPath('documents'), 'novel-editor'),
    filters: [{ name: 'テキスト', extensions: ['txt'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
});
ipcMain.handle('open-dir-dialog', async () => {
  const r = await dialog.showOpenDialog({
    defaultPath: path.join(app.getPath('documents'), 'novel-editor'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('read-abs', (e, { p }) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null));
ipcMain.handle('list-dir', (e, { p }) => {
  const SYSTEM = new Set(['chainhead.txt', 'memo.txt']); // アプリの管理ファイルは話ではない
  try { return fs.readdirSync(p).filter((f) => f.endsWith('.txt') && !f.startsWith('.') && !SYSTEM.has(f)); } catch { return []; }
});
ipcMain.handle('new-dialog', async () => {
  const r = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), 'novel-editor', '新しい作品.txt'),
    filters: [{ name: 'テキスト', extensions: ['txt'] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('write-abs', (e, { p, content }) => {
  try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch {} // 1世代バックアップ
  fs.writeFileSync(p, content, 'utf8');
  return p;
});

// 保存ダイアログ付きエクスポート(どこに出たか分かるように)
ipcMain.handle('export-dialog', async (e, { defaultName, content }) => {
  const r = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), defaultName),
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

// 公証: logHash の SHA-256 を OpenTimestamps カレンダーに刻む(Bitcoin ブロックチェーン=改ざん不能な世界時計)。
// 送るのはハッシュ32バイトのみ。ウォレット不要・無料・原稿の内容は一切出ない。
const https = require('https');
const crypto = require('crypto');
ipcMain.handle('anchor-hash', async (e, { hash }) => {
  const digest = crypto.createHash('sha256').update(hash).digest();
  const calendars = [
    'alice.btc.calendar.opentimestamps.org',
    'bob.btc.calendar.opentimestamps.org',
    'finney.calendar.eternitywall.com',
  ];
  const proofs = [];
  await Promise.allSettled(
    calendars.map(
      (host) =>
        new Promise((res, rej) => {
          const req = https.request({ host, path: '/digest', method: 'POST', timeout: 8000 }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
              if (r.statusCode === 200) proofs.push({ host, proof: Buffer.concat(chunks).toString('base64') });
              res();
            });
          });
          req.on('error', rej);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.write(digest);
          req.end();
        })
    )
  );
  if (!proofs.length) throw new Error('no calendar reachable');
  const dir = path.join(app.getPath('documents'), 'novel-editor');
  fs.mkdirSync(dir, { recursive: true });
  const rec = { at: new Date().toISOString(), logHash: hash, sha256: digest.toString('hex'), proofs };
  fs.appendFileSync(path.join(dir, 'anchors.jsonl'), JSON.stringify(rec) + '\n');
  return { count: proofs.length, sha256: rec.sha256 };
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
  if (process.platform === 'darwin') {
    try { systemPreferences.askForMediaAccess('microphone'); } catch {} // マイク権限の正式要求(音声入力用)
  }
  startLlm();
  // startWhisper(); // 音声入力は休眠中(editor.js の VOICE_UI と対で再開)
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { llmProc?.kill(); } catch {} try { llmProc2?.kill(); } catch {} try { whisperProc?.kill(); } catch {} });
