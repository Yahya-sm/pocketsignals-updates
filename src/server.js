// Local web server: serves the phone-format UI and pushes live state over WebSocket.
// Reachable from the phone in the same Wi-Fi via http://<PC-IP>:<port>.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const UI = path.join(__dirname, '..', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };

function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${port}`);
}

function startServer(engine, { port = 7777, onOpenPO } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api') return handleApi(req, res);
    const file = path.join(UI, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[\\/])+/, ''));
    if (!file.startsWith(UI)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });

  function handleApi(req, res) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let msg = {}; try { msg = JSON.parse(body); } catch {}
      const out = act(msg, false);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  }

  function act(msg, fromDesktop) {
    switch (msg.action) {
      case 'openPO': {
        const sig = engine.signals.find(s => s.id === msg.id);
        const symbol = sig ? sig.symbol : msg.symbol;
        if (!symbol) return { ok: false };
        const saved = engine.openOnPocketOption(symbol, msg.tf);
        const asset = engine.assets.get(symbol);
        if (onOpenPO && fromDesktop) onOpenPO(symbol, asset ? asset.name : symbol, !!msg.tf);
        return { ok: saved, symbol, name: asset ? asset.name : symbol };
      }
      // The PC's session (the plain 42["auth",…] message) to paste on the phone. Only for the local desktop window.
      case 'exportSession':
        if (!fromDesktop || !engine.po.ssid) return { ok: false };
        return { ok: true, code: engine.po.ssid };
      case 'login': if (onOpenPO && fromDesktop) onOpenPO(null, null); return { ok: true }; // open the PocketOption window to log in
      case 'settings': engine.updateSettings(msg.patch || {}); return { ok: true };
      case 'strategy': engine.updateStrategy(msg.name, msg.patch, msg.tfs, msg.presets); return { ok: true };
      case 'resetStrategy': engine.resetStrategy(msg.name); return { ok: true };
      case 'import': return engine.importSettings(msg.data);
      case 'export': return { ok: true, data: engine.exportSettings() };
      case 'ssid': engine.setSsid(String(msg.ssid || '').trim(), msg.url); return { ok: true };
      case 'clear': engine.clearSignals(); return { ok: true };
      case 'scan': engine.scan(); return { ok: true };
      default: return { ok: false };
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  const push = () => { const s = JSON.stringify({ type: 'state', state: { ...engine.state(), lan: lanAddresses(port) } }); wss.clients.forEach(c => c.readyState === 1 && c.send(s)); };
  engine.on('state', push);
  engine.on('signal', sig => { const s = JSON.stringify({ type: 'signal', signal: sig }); wss.clients.forEach(c => c.readyState === 1 && c.send(s)); push(); });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'state', state: { ...engine.state(), lan: lanAddresses(port) } }));
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } const out = act(m, !!m.desktop); ws.send(JSON.stringify({ type: 'reply', reqId: m.reqId, ...out })); });
  });
  setInterval(push, 15000);

  // Resolves once listening; if the port is taken (e.g. by another program), the next free one is used.
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', e => (e.code === 'EADDRINUSE' && left > 0 ? tryPort(p + 1, left - 1) : reject(e)));
      server.listen(p, '0.0.0.0', () => { port = p; resolve({ server, port: p, urls: lanAddresses(p), act }); });
    };
    tryPort(port, 20);
  });
}

module.exports = { startServer, lanAddresses };

// Headless mode: `node src/server.js` runs engine + server without the desktop window.
if (require.main === module) {
  const Engine = require('./engine');
  const engine = new Engine(); engine.start();
  startServer(engine, { port: Number(process.env.PORT) || 7777 })
    .then(({ urls }) => console.log('PocketSignals läuft. Am Handy öffnen:', urls.join('  ')));
}
