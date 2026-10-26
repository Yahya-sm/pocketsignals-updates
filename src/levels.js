// Уровни поддержки/сопротивления по закрытым свечам — для фильтра «не входить по тренду прямо в уровень».
// Те же правила, что в Telegram-боте (level_touch.py) и в проверке на истории OANDA 26.10.2026:
//  * локальный максимум j: high[j] = max(high[j-5..j+5]); засчитывается, только когда справа закрылись ещё 5 свечей;
//  * зона = [P - 0,125·R, P + 0,125·R], R — средний High−Low 20 закрытых свечей на момент подтверждения;
//  * берутся экстремумы за последние 240 свечей; уровень перестаёт действовать после закрытия свечи за зоной.
// Заглядывания в будущее нет: используются только свечи c[0..last].
const W = 5, LB = 240, Z = 0.25;

function avgRange(c, from, to) { // средний High−Low свечей [from, to)
  let s = 0, n = 0;
  for (let k = Math.max(0, from); k < to; k++) { s += c[k].high - c[k].low; n++; }
  return n ? s / n : 0;
}

function isPivot(c, j, hi) {
  const v = hi ? c[j].high : c[j].low;
  for (let k = j - W; k <= j + W; k++) {
    const u = hi ? c[k].high : c[k].low;
    if (hi ? u > v : u < v) return false;
  }
  return true;
}

// Зоны впереди по направлению dir (+1 — сопротивления над ценой для CALL, −1 — поддержки под ценой для PUT).
// Возвращает { dist, R, edge }: расстояние от закрытия последней свечи до ближнего края ближайшей зоны в R
// (0, если цена уже внутри зоны или за её ближним краем; Infinity — уровней впереди нет).
function roomAhead(c, last, dir) {
  const n = last + 1;
  if (n < 60) return { dist: Infinity, R: 0, edge: null };
  const R = avgRange(c, n - 20, n);
  if (!(R > 0)) return { dist: Infinity, R: 0, edge: null };
  const price = c[last].close, hi = dir > 0;
  let best = null;
  for (let j = Math.max(W, n - LB); j < n - W; j++) {
    if (!isPivot(c, j, hi)) continue;
    const a = j + W + 1; if (a - 21 < 0 || a > last) continue;
    const Rc = avgRange(c, a - 21, a - 1); if (!(Rc > 0)) continue;
    const P = hi ? c[j].high : c[j].low;
    const near = P - dir * Z / 2 * Rc, far = P + dir * Z / 2 * Rc;   // ближний и дальний край зоны по ходу движения
    let broken = false;
    for (let k = a; k <= last; k++) if (dir * c[k].close > dir * far) { broken = true; break; }
    if (broken) continue;
    if (dir * far <= dir * price) continue;                            // зона уже позади цены
    const d = Math.max(0, dir * (near - price)) / R;
    if (!best || d < best.dist) best = { dist: d, R, edge: near };
  }
  return best || { dist: Infinity, R, edge: null };
}

module.exports = { roomAhead };
