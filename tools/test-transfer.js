// End-to-end check of the session transfer: the PC server exports a code (with the installed app's session),
// the phone bundle (starting without any session) takes it over and connects.
const fs = require('fs'), os = require('os'), path = require('path'), NodeWS = require('ws');

// PC side: server with a copy of the installed app's data.
const src = path.join(process.env.APPDATA, 'PocketSignals', 'data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-transfer-'));
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
process.env.SIGNAL_DATA = dir;
const Engine = require('../src/engine');
const { startServer } = require('../src/server');
const pc = new Engine();

(async () => {
  const { port } = await startServer(pc, { port: 7799 });
  const code = await new Promise(res => {
    const ws = new NodeWS(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ action: 'exportSession', desktop: true, reqId: 1 })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'reply') res(m.code); });
  });
  console.log('PC-Code:', code ? code.slice(0, 12) + '… (' + code.length + ' Zeichen)' : 'keiner');

  // Phone side: the Android bundle in Node with browser-like globals and an empty storage.
  const store = {};
  global.window = global;
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  global.atob = s => Buffer.from(s, 'base64').toString('binary');
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
  // Like the phone's WebView: no Node "process"/"Buffer".
  new Function('process', 'Buffer', 'module', fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'engine.bundle.js'), 'utf8'))(undefined, undefined, undefined);
  let st; window.LocalEngine.subscribe(m => { if (m.type === 'state') st = m.state; });
  await new Promise(r => setTimeout(r, 2000));
  console.log('Handy vorher:', st.status);
  window.LocalEngine.act({ action: 'ssid', ssid: code }); // pasted 42["auth",…] text, as in the phone UI
  await new Promise(r => setTimeout(r, 6000));
  console.log('Protokoll:\n  ' + st.log.join('\n  '));
  await new Promise(r => setTimeout(r, 6000));
  console.log('Handy nachher:', st.status, '| Paare:', st.watching);
  process.exit(0);
})();
