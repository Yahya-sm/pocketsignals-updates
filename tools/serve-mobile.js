// Serves the Android app's web files (android/.../assets/www) on http://localhost:7790 to test them in a real browser.
const http = require('http'), fs = require('fs'), path = require('path');
const WWW = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  const f = path.join(WWW, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(WWW)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(7790, () => console.log('http://localhost:7790'));
