// Maps PocketOption symbols to app keys (as in signal-app-einstellungen.json) and TradingView symbols.
const TV_SPECIAL = {
  XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', XPTUSD: 'OANDA:XPTUSD', XPDUSD: 'OANDA:XPDUSD',
  UKBRENT: 'TVC:UKOIL', USCRUDE: 'TVC:USOIL', XNGUSD: 'NYMEX:NG1!',
  SP500: 'SP:SPX', NASUSD: 'NASDAQ:NDX', DJI30: 'DJ:DJI', JPN225: 'TVC:NI225', D30EUR: 'XETR:DAX',
  F40EUR: 'EURONEXT:PX1', E35EUR: 'BME:IBC', E50EUR: 'TVC:SX5E', AUS200: 'ASX:XJO', '100GBP': 'TVC:UKX', VIX: 'TVC:VIX',
  BTCUSD: 'BINANCE:BTCUSDT', ETHUSD: 'BINANCE:ETHUSDT', LTCUSD: 'BINANCE:LTCUSDT', ADAUSD: 'BINANCE:ADAUSDT',
  DOTUSD: 'BINANCE:DOTUSDT', BNBUSD: 'BINANCE:BNBUSDT', SOLUSD: 'BINANCE:SOLUSDT', TRXUSD: 'BINANCE:TRXUSDT',
  TONUSD: 'OKX:TONUSDT', LINK: 'BINANCE:LINKUSDT', DOGE: 'BINANCE:DOGEUSDT', AVAX: 'BINANCE:AVAXUSDT',
  MATIC: 'BINANCE:POLUSDT', BITB: 'AMEX:BITB', CITI: 'NYSE:C', FB: 'NASDAQ:META',
};

// "#AAPL_otc" -> { base: "AAPL", otc: true, key: "AAPL_O" }
function parseSymbol(sym) {
  const otc = /_otc$/i.test(sym);
  const base = sym.replace(/^#/, '').replace(/_otc$/i, '');
  return { base, otc, key: otc ? base + '_O' : base };
}

function tvSymbol(sym, type) {
  const { base } = parseSymbol(sym);
  if (TV_SPECIAL[base]) return TV_SPECIAL[base];
  if (type === 'currency' && /^[A-Z]{6}$/.test(base)) return 'FX:' + base;
  if (type === 'cryptocurrency') return 'BINANCE:' + base.replace(/USD$/, '') + 'USDT';
  return base; // stocks: TradingView resolves the ticker itself
}

function tvUrl(sym, type) {
  return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(tvSymbol(sym, type)) + '&interval=1';
}

module.exports = { parseSymbol, tvSymbol, tvUrl };
