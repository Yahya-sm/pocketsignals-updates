// Runs the Android engine bundle in Node with browser-like globals, to check it connects and scans.
const fs = require('fs'), path = require('path'), NodeWS = require('ws');
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-mobile.js')], { stdio: 'inherit' }); // never test a stale bundle
const store = {};
global.window = global;
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
// Browser WebSocket emulation; the real WebView sends Origin https://pocketoption.com by itself.
global.WebSocket = class {
  constructor(url) {
    const s = new NodeWS(url, { headers: { Origin: 'https://pocketoption.com' } });
    s.on('open', () => this.onopen && this.onopen());
    s.on('message', (d, bin) => this.onmessage && this.onmessage({ data: bin ? new Uint8Array(d).buffer : d.toString() }));
    s.on('close', () => this.onclose && this.onclose());
    s.on('error', () => this.onerror && this.onerror());
    this.s = s;
  }
  get readyState() { return this.s.readyState; }
  send(d) { this.s.send(d); }
  close() { this.s.close(); }
};
const code = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'engine.bundle.js'), 'utf8');
// Run like in the phone's WebView: there is no Node "process" or "Buffer" there.
new Function('process', 'Buffer', 'module', code)(undefined, undefined, undefined);
let last;
window.LocalEngine.subscribe(m => { if (m.type === 'state') last = m.state; if (m.type === 'signal') console.log('SIGNAL', m.signal.name, m.signal.dir, m.signal.strategyName); });
setTimeout(() => window.LocalEngine.act({ action: 'scan' }), 4000);
setTimeout(() => {
  console.log('status:', last.status, '| watching:', last.watching, '| assets:', last.assetsKnown, '| strategies:', last.settings.allStrategies.length);
  console.log('switch script ok:', window.poSwitchScript('EUR/USD OTC').includes('EUR/USD'));
  process.exit(0);
}, 16000);
