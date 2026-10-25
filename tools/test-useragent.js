// Does PocketOption accept the installed PC app's real session with different User-Agent headers?
const fs = require('fs'), path = require('path'), WebSocket = require('ws');
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'PocketSignals', 'data', 'config.json'), 'utf8'));
const ssid = cfg.ssid, url = cfg.poUrl || 'wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket';
const sessionUA = (ssid.match(/user_agent\\";s:\d+:\\"(.*?)\\";/) || [])[1];
const variants = {
  'ohne User-Agent': null,
  'User-Agent aus der Sitzung': sessionUA,
  'Android-WebView': 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Mobile Safari/537.36',
  'alte Handy-Kennung': 'Mozilla/5.0 (Linux; Android) SignalApp',
};
function test(ua) {
  return new Promise(res => {
    const headers = { Origin: 'https://pocketoption.com' }; if (ua) headers['User-Agent'] = ua;
    const ws = new WebSocket(url, { headers });
    const done = r => { try { ws.terminate(); } catch {} res(r); };
    ws.on('message', d => { const s = d.toString(); if (s.startsWith('0{')) ws.send('40'); else if (s.startsWith('40')) ws.send(ssid); if (s.includes('successauth')) done('Login angenommen'); if (s.includes('NotAuthorized')) done('ABGELEHNT'); });
    ws.on('close', () => done('Verbindung getrennt ohne Login'));
    ws.on('error', e => done('Fehler ' + e.message));
    setTimeout(() => done('keine Antwort'), 8000);
  });
}
(async () => {
  console.log('Sitzung:', /"isDemo":0/.test(ssid) ? 'Echtgeld' : 'Demo', '| UA in Sitzung:', sessionUA ? sessionUA.slice(0, 60) + '…' : 'keiner');
  for (const [name, ua] of Object.entries(variants)) console.log(name.padEnd(28), await test(ua));
  process.exit(0);
})();
