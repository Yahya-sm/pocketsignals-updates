// Opens several connections with the same session one after another and reports which stay authorized.
const fs = require('fs'), path = require('path'), WebSocket = require('ws');
const ssid = fs.readFileSync(path.join(__dirname, '..', '..', 'signal-zugang.txt'), 'utf8').match(/PO_SSID='(.+)'/)[1];
const state = {};
function open(n) {
  const ws = new WebSocket('wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket', { headers: { Origin: 'https://pocketoption.com' } });
  state[n] = 'connecting';
  ws.on('message', d => {
    const s = d.toString();
    if (s.startsWith('0{')) ws.send('40'); else if (s.startsWith('40')) ws.send(ssid); else if (s === '2') ws.send('3');
    if (s.includes('successauth')) state[n] = 'auth';
    if (s.includes('NotAuthorized')) state[n] = 'NotAuthorized';
  });
  ws.on('close', c => { state[n] = 'closed ' + c; });
}
[1, 2, 3, 4].forEach((n, i) => setTimeout(() => open(n), i * 2500));
setTimeout(() => { console.log(state); process.exit(0); }, 20000);
