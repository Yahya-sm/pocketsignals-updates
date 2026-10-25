// Which Origin headers does the PocketOption socket accept? Tries each and reports whether auth succeeds.
const fs = require('fs'), path = require('path'), WebSocket = require('ws');
const ssid = fs.readFileSync(path.join(__dirname, '..', '..', 'signal-zugang.txt'), 'utf8').match(/PO_SSID='(.+)'/)[1];
const origins = ['https://pocketoption.com', 'https://signal-app.pocketoption.com', 'https://m.pocketoption.com', 'https://appassets.androidplatform.net', null];
function test(origin) {
  return new Promise(res => {
    const ws = new WebSocket('wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket', origin ? { headers: { Origin: origin } } : {});
    const done = r => { try { ws.terminate(); } catch {} res(r); };
    ws.on('message', d => { const s = d.toString(); if (s.startsWith('0{')) ws.send('40'); else if (s.startsWith('40')) ws.send(ssid); if (s.includes('successauth')) done('OK'); if (s.includes('NotAuthorized')) done('abgelehnt'); });
    ws.on('unexpected-response', (_q, r) => done('HTTP ' + r.statusCode));
    ws.on('error', e => done('Fehler ' + e.message));
    setTimeout(() => done('keine Antwort'), 6000);
  });
}
(async () => { for (const o of origins) console.log(String(o).padEnd(42), await test(o)); process.exit(0); })();
