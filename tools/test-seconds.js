// Checks second timeframes: with two strategies set to S10/S30 the engine fetches those candles and evaluates them.
const fs = require('fs'), os = require('os'), path = require('path');
const src = path.join(process.env.APPDATA, 'PocketSignals', 'data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sec-'));
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
process.env.SIGNAL_DATA = dir;
const Engine = require('../src/engine');
const strategies = require('../src/strategies');
const e = new Engine();
Object.assign(e.settings, { strategies: ['n_sharp', 'n_big', 'n_stoch'], trend_filter: false, min_strength: 0,
  strat_tfs: { n_sharp: ['S10'], n_big: ['S30'], n_stoch: ['S15', 'M1'] } });
let secAnswers = 0;
const orig = e._onSecondHistory.bind(e);
e._onSecondHistory = (h, sec) => { secAnswers++; if (secAnswers <= 3) console.log(`S${sec}: ${h.asset} – ${h.data.length} Kerzen, letzte ${new Date(h.data[h.data.length - 1].time * 1000).toLocaleTimeString()}`); orig(h, sec); };
e.on('signal', s => console.log('SIGNAL', s.tf, s.name, s.dir, 'Einstieg', new Date(s.entryTime * 1000).toLocaleTimeString(), 'Ablauf', s.expiry + 's'));
e.po.on('ready', () => setTimeout(() => e.scan(), 1000));
e.po.connect();
setTimeout(() => {
  console.log('Sekunden-Zeitrahmen:', e.secondTimeframes(), '| Antworten:', secAnswers);
  process.exit(0);
}, 15000);
