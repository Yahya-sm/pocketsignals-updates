// PocketOption socket.io client (Engine.IO v4 over raw WebSocket).
// Binary frames follow a "451-[event,{_placeholder}]" text frame, so we remember the pending event name.
const WebSocket = require('ws');
const EventEmitter = require('events');

const PO_SERVER = /^wss:\/\/[a-z0-9-]+\.po\.market\//i;
// PocketOption's chart timeframes in seconds, in the order of its chartPeriod index (… D1).
// Checked against the app: index 4 shows M2 and index 7 shows M10, so M1 is index 3.
const CHART_PERIODS = [5, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400];

class POClient extends EventEmitter {
  constructor(ssid, url) {
    super();
    this.ssid = ssid;
    this.url = PO_SERVER.test(url || '') ? url : null; // server the PocketOption page itself used
    this.ws = null;
    this.pending = null;
    this.authed = false;
    this.charts = [];
    this.retry = null;
    this.log = [];   // connection log shown in the app (Settings → Connection log)
  }

  _log(msg) {
    const t = new Date().toLocaleTimeString('de-DE');
    this.log.push(`${t}  ${msg}`);
    if (this.log.length > 60) this.log.shift();
    this.emit('log');
  }

  // Session for the log: account type and a shortened session id, never the full secret.
  _describeSsid() {
    const s = this.ssid || '';
    const demo = /"isDemo"\s*:\s*1/.test(s) ? 'Demo' : 'Real';
    return `${demo}-Sitzung, ${s.length} Zeichen, Format ${s.startsWith('42["auth"') ? 'ok' : 'FALSCH'}`;
  }

  get host() {
    const demo = /"isDemo"\s*:\s*1/.test(this.ssid || '');
    return demo ? 'demo-api-eu.po.market' : 'api-eu.po.market';
  }

  connect() {
    if (!this.ssid) { this._log('Keine Sitzung gespeichert'); this.emit('status', 'no_ssid'); return; }
    clearTimeout(this.retry);
    const url = this.url || `wss://${this.host}/socket.io/?EIO=4&transport=websocket`;
    this._log(`Verbinde mit ${url.replace(/^wss:\/\//, '').split('/')[0]} – ${this._describeSsid()}`);
    const ws = new WebSocket(url, { headers: { Origin: 'https://pocketoption.com' } });
    this.ws = ws;
    this.emit('status', 'connecting');
    ws.on('open', () => this._log('Server erreicht'));
    // PocketOption ends the session after ~2 min ("41", code 1005) unless the client sends 42["ps"] like the website does.
    ws.keepAlive = setInterval(() => ws.readyState === 1 && ws.send('42["ps"]'), 20000);
    ws.on('message', (d, bin) => this._onMessage(d.toString(), bin));
    ws.on('close', (code, reason) => {
      this._log(`Verbindung getrennt${code ? ' (Code ' + code + ')' : ''}${reason && String(reason) !== 'closed' ? ': ' + reason : ''}${this.authed ? '' : ' – ohne Login'}`);
      this.authed = false;
      clearInterval(ws.keepAlive);
      this.emit('status', 'retry');
      if (this.ws === ws) this.retry = setTimeout(() => this.connect(), 5000);
    });
    ws.on('error', e => {
      this.lastError = e.message; this._log('Fehler: ' + e.message); this.emit('status', 'error');
      // Since 27.10.2026 PocketOption's only demo server does not answer; signals then need a real-account session.
      if (/demo-api/.test(url)) this._log('Demo-Server von PocketOption antwortet nicht – in PocketOption aufs Real-Konto wechseln (Login wird übernommen)');
    });
  }

  setSsid(ssid, url) {
    this.ssid = ssid;
    this.url = PO_SERVER.test(url || '') ? url : null;
    if (this.ws) { const old = this.ws; this.ws = null; old.close(); }
    this.connect();
  }

  _onMessage(s, bin) {
    if (bin) {
      const ev = this.pending; this.pending = null;
      let data; try { data = JSON.parse(s); } catch { return; }
      this._onEvent(ev, data);
      return;
    }
    if (s.startsWith('0{')) { this._log('Server-Handshake ok'); return this.ws.send('40'); }
    if (s.startsWith('40')) { this._log('Sende Login (Sitzung)'); return this.ws.send(this.ssid); }
    if (s === '2') return this.ws.send('3');
    const m = s.match(/^451-\["(\w+)"/);
    if (m) { this.pending = m[1]; return; }
    const t = s.match(/^42\["(\w+)",?(.*)\]$/);
    if (t) {
      let data = null; try { data = t[2] ? JSON.parse(t[2]) : null; } catch {}
      this._onEvent(t[1], data);
    }
  }

  _onEvent(ev, data) {
    switch (ev) {
      case 'successauth':
        this.authed = true; this.lastError = null; this._log('Login angenommen ✓'); this.emit('status', 'connected');
        this._measureClock();
        break;
      case 'NotAuthorized': this._log('Login ABGELEHNT – Sitzung ungültig oder abgelaufen'); this.emit('status', 'expired'); break;
      case 'updateAssets': if (!this.assetsLogged) { this.assetsLogged = true; this._log(`Paare-Liste erhalten (${(data || []).length})`); } this.emit('assets', data); break;
      case 'updateCharts': this.charts = data || []; break;
      case 'loadHistoryPeriodFast':
      case 'loadHistoryPeriod':
        // Candle times come in PocketOption's clock: convert them to real time for the rest of the app.
        if (data && Array.isArray(data.data) && this.clockOffset) data.data = data.data.map(k => ({ ...k, time: k.time - this.clockOffset }));
        if (this.clockKnown) this.emit('history', data); // answers before the clock is known would be hours old
        break;
      case 'updateStream': // live prices [[asset, time, price], …] of the subscribed pairs
        if (!Array.isArray(data)) break;
        if (!this.clockKnown && Array.isArray(data[0]) && data[0][1] > 1e9) this._setClock(data[0][1]);
        this.emit('stream', data.map(r => [r[0], r[1] - (this.clockOffset || 0), r[2]]));
        break;
      case 'updateHistoryNewFast': // after subscribing: the pair's prices of the last ~10 minutes, [[time, price], …]
        if (this.clockKnown && data && data.asset && Array.isArray(data.history))
          this.emit('ticks', { asset: data.asset, ticks: data.history.map(r => [r[0] - (this.clockOffset || 0), r[1]]) });
        break;
    }
  }

  // Since the end of October 2026 PocketOption's clock runs ~2 h ahead (OTC prices carry those timestamps). A history
  // request with the real time then returns candles from two hours ago – signals on old prices that don't match the
  // chart. So after the login: subscribe to one pair, compare its first live price time with our clock, round to whole
  // minutes, and only then start ('ready'). Without an answer within 6 s it starts with offset 0 (as before).
  _measureClock() {
    this.clockKnown = false;
    clearTimeout(this.clockTimer);
    this.send('changeSymbol', { asset: 'EURUSD_otc', period: 60 });
    this.clockTimer = setTimeout(() => { if (!this.clockKnown) { this._log('PocketOption-Uhrzeit nicht ermittelt – rechne ohne Versatz'); this._setClock(null); } }, 6000);
  }

  _setClock(serverTime) {
    if (this.clockKnown) return;
    clearTimeout(this.clockTimer);
    const off = serverTime ? Math.round((serverTime - Date.now() / 1000) / 60) * 60 : 0;
    this.clockOffset = off; this.clockKnown = true;
    if (off) this._log(`PocketOption-Uhr geht ${off > 0 ? '+' : ''}${(off / 3600).toFixed(2).replace(/\.?0+$/, '')} h – wird ausgeglichen`);
    this.emit('ready');
  }

  send(ev, payload) {
    if (this.ws && this.ws.readyState === 1) this.ws.send('42' + JSON.stringify([ev, payload]));
  }

  // Returns the request index; PocketOption echoes it in the answer (used to tell periods apart).
  loadHistory(asset, period, seconds) {
    // Unique per request (a random part could repeat within one second and mix up the answers).
    this.reqNo = ((this.reqNo || 0) + 1) % 1000;
    const t = Math.floor(Date.now() / 1000), index = t * 1000 + this.reqNo;
    this.send('loadHistoryPeriod', { asset, index, time: t + (this.clockOffset || 0), offset: seconds, period });
    return index;
  }

  // Live prices for a pair (PocketOption's history ends ~5 minutes before now; the newest minutes come from these).
  subscribe(asset) { this.send('changeSymbol', { asset, period: 60 }); }

  // Saves the symbol (and optionally the timeframe in seconds) into the account's main chart, so PocketOption
  // (app or web) opens on that asset. chartPeriod is an index into PocketOption's timeframe list.
  openOnAccount(symbol, periodSec) {
    const c = this.charts.find(x => x.chart_id === 'chart-1') || this.charts[0];
    if (!c) return false;
    let st = c.settings; while (typeof st === 'string') st = JSON.parse(st);
    st.symbol = symbol;
    const idx = CHART_PERIODS.indexOf(periodSec);
    if (idx >= 0) st.chartPeriod = idx;
    this.send('saveCharts', { chartId: c.chart_id, settings: st });
    c.settings = JSON.stringify(st);
    return true;
  }
}

module.exports = POClient;
