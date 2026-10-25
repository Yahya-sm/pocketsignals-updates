// Checks fast scanning: with a 5 s interval the engine should scan ~5 times in 25 s and get candles back each time.
const Engine = require('../src/engine');
const e = new Engine();
e.settings.scan_interval = 5;          // in memory only, not saved
let scans = 0, histories = 0, partial = 0;
const scan = e.scan.bind(e);
e.scan = () => { if (e.po.authed) scans++; scan(); };
e.po.on('history', h => { histories++; if (h.data && h.data.some(k => k.time === Math.floor(Date.now() / 60000) * 60)) partial++; });
e.on('signal', s => console.log('SIGNAL', s.name, s.dir, s.strategyName.de, 'Einstieg', new Date(s.entryTime * 1000).toLocaleTimeString('de-DE')));
e.start();
setTimeout(() => {
  console.log(`scans: ${scans}, history responses: ${histories}, with forming candle: ${partial}, watching: ${e.selectedAssets().length}`);
  process.exit(0);
}, 27000);
