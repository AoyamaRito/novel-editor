// Electron main: ローカル専用の執筆アプリ。リモートコンテンツは一切読まない。
// webSecurity:false / nodeIntegration:true は file:// 上の ES module + IPC レス fs 利用の割り切り
// (完全ローカル・自分の原稿のみという前提でのみ正当)。
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
ipcMain.handle('append-file', (e, { name, content }) => {
  const dir = path.join(app.getPath('documents'), 'novel-editor');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.appendFileSync(p, content, 'utf8');
  return p;
});

ipcMain.handle('read-file', (e, { name }) => {
  const p = path.join(app.getPath('documents'), 'novel-editor', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
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
  startLlm();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { llmProc?.kill(); } catch {} });
