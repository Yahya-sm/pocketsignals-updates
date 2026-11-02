// Turns the backtest results of the three strategies (probt-adx/bor/apc.json from the walk-forward backtest) into the
// folded result tables shown in the app: writes src/pro_tests_data.js. Usage: node tools/gen-pro-tests.js <dir with probt-*.json>
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `probt-${n}.json`), 'utf8'));
const DAYS = 4.99; // history span of the test (28.10.2026 11:15 – 02.11.2026 11:08 UTC)
const pc = x => (x == null ? '–' : `${(100 * x).toFixed(0)} %`);
const L = (ru, de, en) => ({ ru, de, en });
// short headers (the phone is narrow); the explanation is in the first words of each note
const cols = [L('Вариант', 'Variante', 'Variant'), L('В день', 'Pro Tag', 'Per day'), L('Отбор', 'Auswahl', 'Selection'), L('Тест [95 %]', 'Test [95 %]', 'Test [95 %]'), L('Ожид.', 'Erw.', 'Exp.')];
const KEY = L('«В день» — сигналов в день на все пары; в скобках число сделок; «Ожид.» — ожидаемый результат на 1 при выплате 85 %. ', '„Pro Tag“ – Signale pro Tag für alle Paare; in Klammern die Zahl der Trades; „Erw.“ – erwartetes Ergebnis je 1 bei 85 % Auszahlung. ', '"Per day" – signals per day for all pairs; trades in brackets; "Exp." – expected result per 1 at an 85 % payout. ');
const withKey = n => (n ? L(KEY.ru + n.ru, KEY.de + n.de, KEY.en + n.en) : KEY);
const row = (r, label) => [label || r.label, (r.signals / DAYS).toFixed(1), `${pc(r.tr.wr)} (${r.tr.n})`, `${pc(r.te.wr)} [${pc(r.te.lo)}–${pc(r.te.hi)}] (${r.te.n})`, r.te.ev == null ? '–' : (r.te.ev >= 0 ? '+' : '') + r.te.ev.toFixed(2)];
const pick = (res, label, tf, exp) => res.find(r => r.label === label && r.tf === tf && r.expiry === exp);
const table = (title, res, items) => ({ title, cols, rows: items.map(([label, tf, exp, shown]) => { const r = pick(res, label, tf, exp); return r ? row(r, shown) : null; }).filter(Boolean) });
const out = {};

const adx = load('adx');
out.n_adxmicro = [
  { ...table(L('Результаты проверки: M1, экспирация 2 мин (5 дней, 17 OTC-пар)', 'Testergebnisse: M1, Ablauf 2 Min. (5 Tage, 17 OTC-Paare)', 'Test results: M1, 2 min expiry (5 days, 17 OTC pairs)'), adx,
    [['A BASE ADX', 1, 2], ['B ADX CROSS', 1, 2], ['B thr 20', 1, 2], ['B thr 30', 1, 2], ['B hyst 6 / cd 10', 1, 2], ['C BOTH (closed)', 1, 2], ['C PRE only', 1, 2], ['C CROSS only', 1, 2], ['C PRE + ADX≥25', 1, 2], ['C PRE + RSI overheat', 1, 2], ['D example', 1, 2]]),
    note: L('Безубыток при выплате 85 % — 54,05 %. «Отбор» — первые 3 дня, «Тест» — последние 2 дня, не участвовавшие в выборе. Режимы A–D дают около 50 % и отрицательное ожидание; режим C даёт очень много сигналов (≈ 2000 в день на все пары) без преимущества. RSI-перегрев почти ничего не меняет. LIVE на истории не проверялся (нет тиков). Это история, не обещание.',
      'Break-even bei 85 % Auszahlung: 54,05 %. „Auswahl“ – die ersten 3 Tage, „Test“ – die letzten 2 Tage, die nicht in die Wahl eingingen. Die Modi A–D liegen bei etwa 50 % mit negativer Erwartung; Modus C liefert sehr viele Signale (≈ 2000 pro Tag für alle Paare) ohne Vorteil. RSI-Überhitzung ändert kaum etwas. LIVE wurde auf der Historie nicht geprüft (keine Ticks). Historie, kein Versprechen.',
      'Break-even at an 85 % payout: 54.05 %. "Selection" – the first 3 days, "Test" – the last 2 days not used for the choice. Modes A–D sit near 50 % with a negative expectation; mode C gives a huge number of signals (≈ 2000 a day for all pairs) with no edge. RSI overheat changes almost nothing. LIVE was not tested on history (no ticks). History, not a promise.') },
  { ...table(L('Другие таймфреймы и сроки (A, B, C)', 'Andere Zeitrahmen und Laufzeiten (A, B, C)', 'Other timeframes and expiries (A, B, C)'), adx,
    [['A BASE ADX', 2, 4, 'A · M2 · 4 мин'], ['A BASE ADX', 3, 6, 'A · M3 · 6 мин'], ['A BASE ADX', 5, 10, 'A · M5 · 10 мин'], ['B ADX CROSS', 2, 4, 'B · M2 · 4 мин'], ['B ADX CROSS', 3, 6, 'B · M3 · 6 мин'], ['B ADX CROSS', 5, 10, 'B · M5 · 10 мин'], ['C BOTH (closed)', 2, 4, 'C · M2 · 4 мин'], ['C BOTH (closed)', 3, 6, 'C · M3 · 6 мин'], ['C BOTH (closed)', 5, 10, 'C · M5 · 10 мин']]),
    note: L('Нигде нет устойчивого результата выше безубытка: где «Тест» выше «Отбора», это разброс малой выборки.', 'Nirgends ein stabiles Ergebnis über dem Break-even: wo „Test“ über „Auswahl“ liegt, ist das Streuung kleiner Stichproben.', 'Nowhere a stable result above break-even: where "Test" is above "Selection" it is the scatter of a small sample.') },
];

const bor = load('bor');
out.n_bor = [
  { ...table(L('Результаты проверки: M1, экспирация 2 мин (5 дней, 17 OTC-пар)', 'Testergebnisse: M1, Ablauf 2 Min. (5 Tage, 17 OTC-Paare)', 'Test results: M1, 2 min expiry (5 days, 17 OTC pairs)'), bor,
    [['BOR OFF', 1, 2, 'OFF'], ['BOR STANDARD', 1, 2, 'STANDARD'], ['BOR STRICT', 1, 2, 'STRICT'], ['BOR 1 conf', 1, 2, L('STANDARD · 1 подтв.', 'STANDARD · 1 Best.', 'STANDARD · 1 conf.')], ['BOR 3 conf', 1, 2, L('STANDARD · 3 подтв.', 'STANDARD · 3 Best.', 'STANDARD · 3 conf.')], ['BOR STANDARD + RSI overheat', 1, 2, 'STANDARD + RSI']]),
    note: L('Безубыток при выплате 85 % — 54,05 %. «Отбор» — первые 3 дня, «Тест» — последние 2 дня. Сигналов мало: доверительные интервалы широкие, вывод о прибыльности сделать нельзя.', 'Break-even bei 85 % Auszahlung: 54,05 %. „Auswahl“ – die ersten 3 Tage, „Test“ – die letzten 2 Tage. Wenige Signale: die Konfidenzintervalle sind breit, ein Schluss auf Profitabilität ist nicht möglich.', 'Break-even at an 85 % payout: 54.05 %. "Selection" – the first 3 days, "Test" – the last 2 days. Few signals: the confidence intervals are wide, no conclusion about profitability is possible.') },
  { ...table(L('Другие таймфреймы и сроки (STANDARD)', 'Andere Zeitrahmen und Laufzeiten (STANDARD)', 'Other timeframes and expiries (STANDARD)'), bor,
    [['BOR STANDARD', 2, 2, 'M2 · 2 мин'], ['BOR STANDARD', 2, 4, 'M2 · 4 мин'], ['BOR STANDARD', 3, 3, 'M3 · 3 мин'], ['BOR STANDARD', 3, 6, 'M3 · 6 мин'], ['BOR STANDARD', 5, 5, 'M5 · 5 мин'], ['BOR STANDARD', 5, 10, 'M5 · 10 мин']]), note: null },
];

const apc = load('apc');
out.n_apc = [
  { ...table(L('Результаты проверки: M1, экспирация 2 мин (5 дней, 17 OTC-пар)', 'Testergebnisse: M1, Ablauf 2 Min. (5 Tage, 17 OTC-Paare)', 'Test results: M1, 2 min expiry (5 days, 17 OTC pairs)'), apc,
    [['APC P1', 1, 2, 'P1 CONSERVATIVE'], ['APC P2', 1, 2, 'P2 BALANCED'], ['APC P3', 1, 2, 'P3 EARLY ENTRY'], ['APC P4', 1, 2, 'P4 TREND CONTINUATION'], ['APC P5', 1, 2, 'P5 VOLATILITY ADAPTIVE'], ['APC P2 without RSI/ext/exh', 1, 2, L('P2 без RSI/растяжения/истощения', 'P2 ohne RSI/Dehnung/Erschöpfung', 'P2 without RSI/extension/exhaustion')], ['APC P2 RSI only', 1, 2, L('P2 только RSI', 'P2 nur RSI', 'P2 RSI only')]]),
    note: L('Безубыток при выплате 85 % — 54,05 %. «Отбор» — первые 3 дня, «Тест» — последние 2 дня. Все пресеты около 50 %; фильтры RSI/растяжения/истощения сокращают число сигналов, но не меняют долю выигрышей. P5 почти совпадает с P2: после импульса активность и так высокая, MAM почти не блокирует.', 'Break-even bei 85 % Auszahlung: 54,05 %. „Auswahl“ – die ersten 3 Tage, „Test“ – die letzten 2 Tage. Alle Presets um 50 %; die Filter RSI/Dehnung/Erschöpfung verringern die Signalzahl, ändern aber nicht die Gewinnquote. P5 gleicht fast P2: nach einem Impuls ist die Aktivität ohnehin hoch, MAM blockiert kaum.', 'Break-even at an 85 % payout: 54.05 %. "Selection" – the first 3 days, "Test" – the last 2 days. All presets around 50 %; the RSI/extension/exhaustion filters cut the number of signals but do not change the win share. P5 almost equals P2: after an impulse the activity is high anyway, MAM hardly blocks.') },
  { ...table(L('Другие таймфреймы и сроки (P1, P2, P4)', 'Andere Zeitrahmen und Laufzeiten (P1, P2, P4)', 'Other timeframes and expiries (P1, P2, P4)'), apc,
    [['APC P1', 2, 4, 'P1 · M2 · 4 мин'], ['APC P1', 5, 10, 'P1 · M5 · 10 мин'], ['APC P2', 2, 4, 'P2 · M2 · 4 мин'], ['APC P2', 3, 6, 'P2 · M3 · 6 мин'], ['APC P2', 5, 10, 'P2 · M5 · 10 мин'], ['APC P4', 2, 4, 'P4 · M2 · 4 мин'], ['APC P4', 5, 15, 'P4 · M5 · 15 мин']]),
    note: L('Осторожно: у ряда строк «Тест» выше безубытка (P2 · M2 · 4 мин, P1 · M5 · 10 мин), но «Отбор» у них ниже 50 %. Это противоречие — признак случайного разброса, а не найденного преимущества. Лучшие по тесту варианты нельзя выбирать «по тесту»: это подгонка.', 'Vorsicht: bei einigen Zeilen liegt „Test“ über dem Break-even (P2 · M2 · 4 Min., P1 · M5 · 10 Min.), aber „Auswahl“ unter 50 %. Dieser Widerspruch ist ein Zeichen zufälliger Streuung, kein gefundener Vorteil. Die besten Varianten im Test dürfen nicht „nach dem Test“ gewählt werden: das wäre Überanpassung.', 'Careful: for some rows "Test" is above break-even (P2 · M2 · 4 min, P1 · M5 · 10 min) but "Selection" is below 50 %. That contradiction is a sign of random scatter, not a found edge. The variants that look best in the test must not be chosen "by the test": that would be overfitting.') },
];

// every note starts with the explanation of the short column headers
for (const list of Object.values(out)) for (const t of list) t.note = withKey(t.note);

const text = `// Generated by tools/gen-pro-tests.js from the walk-forward backtest of ${new Date().toISOString().slice(0, 10)} – do not edit by hand.\nmodule.exports = ${JSON.stringify(out, null, 1)};\n`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'pro_tests_data.js'), text);
console.log('written', text.length, 'bytes;', Object.values(out).map(v => v.map(t => t.rows.length).join('+')).join(' | '), 'rows');
