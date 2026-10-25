// Fallback check: a bad session stored like on the phones (taken over, no flag) must be replaced by the
// built-in one within ~20 s, and the engine must connect. Uses a temporary data folder.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fallback-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ssid: '42["auth",{"session":"kaputt123","isDemo":1,"uid":1,"platform":2}]', poUrl: 'wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket' }));
process.env.SIGNAL_DATA = dir;
const Engine = require('../src/engine');
const e = new Engine();
const t0 = Date.now();
e.po.on('status', s => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', s));
e.start();
setTimeout(() => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  console.log('connected:', e.po.authed, '| rejected:', (cfg.rejected || []).length, '| lastGood saved:', !!cfg.lastGood);
  process.exit(0);
}, 30000);
