package com.signalapp.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;

/**
 * Three WebViews: the signal app (engine + UI from assets), PocketOption and TradingView.
 * The signal page has its own address; its connection to PocketOption goes through PoSocket,
 * which sends the Origin header the server requires.
 */
public class MainActivity extends Activity {
    static final String APP_BASE = "https://appassets.androidplatform.net/www/";
    static final String PO_ORIGIN = "https://pocketoption.com";
    final java.util.Map<Integer, PoSocket> sockets = new java.util.concurrent.ConcurrentHashMap<>();
    static final String PO_URL = "https://pocketoption.com/en/cabinet/";
    static final String CHANNEL = "signals";

    WebView signals, po, tv;
    TextView backBtn, dirBadge;
    String dirText = null; // current direction badge text, null = none
    Runnable dirHide = null;
    String pendingPoName = null;
    volatile String poUserAgent = null;
    volatile String poStart = null; // demo or real trading page, set by the app (settings / last used)
    String lastPoMode = null;
    boolean poLoaded = false;
    int notifyId = 100;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.parseColor("#0f1522"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f1522"));

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Signale", NotificationManager.IMPORTANCE_HIGH);
            ch.enableVibration(true);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
            // One channel per signal sound (res/raw/sig_<key>.wav, made by tools/make-sounds.js); "none" has no sound.
            String[] keys = {"default", "bell", "double", "beep", "rise", "fall", "gong", "alarm", "none"};
            android.media.AudioAttributes aa = new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
            for (String k : keys) {
                NotificationChannel c = new NotificationChannel("sig_" + k, "Signale – " + k, NotificationManager.IMPORTANCE_HIGH);
                c.enableVibration(true);
                int raw = getResources().getIdentifier("sig_" + k, "raw", getPackageName());
                if (raw != 0) c.setSound(android.net.Uri.parse("android.resource://" + getPackageName() + "/" + raw), aa); else c.setSound(null, null);
                getSystemService(NotificationManager.class).createNotificationChannel(c);
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0e16"));
        CookieManager.getInstance().setAcceptCookie(true);

        signals = makeWebView();
        signals.addJavascriptInterface(new Bridge(), "AndroidApp");
        signals.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (!url.startsWith(APP_BASE)) return null;
                String file = url.substring(APP_BASE.length()).split("[?#]")[0];
                if (file.isEmpty()) file = "index.html";
                try {
                    InputStream in = getAssets().open("www/" + file);
                    return new WebResourceResponse(mime(file), "utf-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                        new java.util.HashMap<>(), new java.io.ByteArrayInputStream(("missing asset: " + file).getBytes()));
                }
            }
        });

        po = makeWebView();
        CookieManager.getInstance().setAcceptThirdPartyCookies(po, true);
        po.addJavascriptInterface(new AuthBridge(), "SignalAppAuth");
        // Since 10/2026 PocketOption sends phones to m.pocketoption.com – made for phone screens, same pair list
        // (.pair-number-wrap / .current-symbol), so switching pairs works there too. Keep the phone's own user agent.
        poUserAgent = po.getSettings().getUserAgentString();
        // Diagnosis: errors and warnings of the PocketOption page (e.g. failed connections) → the app's connection log.
        po.setWebChromeClient(new WebChromeClient() {
            int sent = 0;
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR && sent++ < 30)
                    new AuthBridge().onPoLog("PO-Seite: " + m.message());
                return false;
            }
        });
        po.setWebViewClient(new WebViewClient() {
            // Diagnosis: failed loads of the PocketOption page (no network, blocked server …) → the app's log.
            int errs = 0;
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (errs++ < 20) new AuthBridge().onPoLog("PO-Seite lädt nicht: " + req.getUrl().getHost() + " – " + err.getDescription());
            }

            // Links to other apps (intent:, market:, tg: …) would show an error page in the WebView: open them outside instead.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String scheme = req.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try { startActivity(Intent.parseUri(req.getUrl().toString(), Intent.URI_INTENT_SCHEME)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                view.evaluateJavascript(AUTH_HOOK, null);
            }

            // Remember demo or real for the next start (also for in-page navigation).
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                String mode = url == null || !url.contains("/cabinet/") ? null
                    : url.contains("/cabinet/demo-") ? "demo"
                    : url.matches(".*/cabinet/(quick-high-low|high-low|digital|forex).*") ? "real" : null;
                if (mode != null && !mode.equals(lastPoMode)) {
                    lastPoMode = mode;
                    signals.evaluateJavascript("window.LocalEngine && window.LocalEngine.act({action:'settings',patch:{po_last_mode:'" + mode + "'}})", null);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(AUTH_HOOK, null);
                if (url.contains("/cabinet")) { poLoaded = true; if (pendingPoName != null) switchPo(pendingPoName); }
            }
        });

        tv = makeWebView();
        tv.setWebViewClient(new WebViewClient());
        // TradingView's sign-in opens its own window and needs third-party cookies: allow both, and show such
        // windows in an overlay (before, the screen just went black).
        CookieManager.getInstance().setAcceptThirdPartyCookies(tv, true);
        tv.getSettings().setSupportMultipleWindows(true);
        tv.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);
        tv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                closeTvPopup();
                tvPopup = makeWebView();
                CookieManager.getInstance().setAcceptThirdPartyCookies(tvPopup, true);
                tvPopup.setWebViewClient(new WebViewClient());
                tvPopup.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView w) { closeTvPopup(); }
                });
                ((FrameLayout) tv.getParent()).addView(tvPopup, match());
                backBtn.bringToFront();
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(tvPopup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        root.addView(signals, match());
        root.addView(po, match());
        root.addView(tv, match());
        // INVISIBLE, not GONE: GONE gives the view size 0, and PocketOption's mobile page then builds its chart 0×0
        // while loading in the background – the chart stayed empty when the tab was opened.
        po.setVisibility(View.INVISIBLE);
        tv.setVisibility(View.INVISIBLE);

        // Floating "back to signals" button shown over PocketOption / TradingView.
        backBtn = new TextView(this);
        backBtn.setText("⚡ Signale");
        backBtn.setTextColor(Color.WHITE);
        backBtn.setTextSize(14);
        backBtn.setPadding(36, 22, 36, 22);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E64C8DFF"));
        bg.setCornerRadius(60);
        backBtn.setBackground(bg);
        backBtn.setElevation(12);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.START);
        lp.setMargins(30, 0, 0, 170);
        root.addView(backBtn, lp);
        backBtn.setVisibility(View.GONE);
        backBtn.setOnClickListener(v -> show(signals));

        // Direction badge over PocketOption (user 14.11.2026: "I forget the signal's direction once the chart is open"):
        // bottom left, above the back button – green ▲ CALL / red ▼ PUT with pair and expiry. Tap hides it; it also goes
        // away by itself once the signal is old (set by the signal page via Bridge.setDirBadge).
        dirBadge = new TextView(this);
        dirBadge.setTextColor(Color.WHITE);
        // 14.11.2026 (user): small, at the left edge in the middle – the bottom covered the Stochastic.
        dirBadge.setTextSize(12);
        dirBadge.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        dirBadge.setPadding(18, 8, 18, 8);
        dirBadge.setElevation(14);
        FrameLayout.LayoutParams dl = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL | Gravity.START);
        dl.setMargins(6, 0, 0, 0);
        root.addView(dirBadge, dl);
        dirBadge.setVisibility(View.GONE);
        dirBadge.setOnClickListener(v -> { dirText = null; dirBadge.setVisibility(View.GONE); });

        setContentView(root);
        signals.loadUrl(APP_BASE + "index.html");
        // PocketOption loads once the app has said demo or real (setPoStart); fallback after 5 s.
        root.postDelayed(() -> { if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL); }, 5000);

        handleAction(getIntent()); // app was started from a notification button

        if (bgOn()) startSignalService();
        // Wake the engine every 30 s while signals may run (screen on, or "signals with the screen off" switched on):
        // a lost connection is rebuilt even if JS timers slept.
        root.postDelayed(new Runnable() { public void run() {
            if (bgOn() || isScreenOn()) {
                signals.resumeTimers();
                signals.evaluateJavascript("window.__psWake&&window.__psWake()", null);
            }
            root.postDelayed(this, 30000);
        } }, 30000);
    }

    // "Signals with the screen off" (switch in the app, green/red), stored on the phone. On: foreground service with a
    // wake lock keeps the engine scanning in the background. Off: no service – Android pauses the app with the screen.
    boolean bgOn() { return getSharedPreferences("app", MODE_PRIVATE).getBoolean("bg_signals", true); }
    boolean isScreenOn() { return ((android.os.PowerManager) getSystemService(POWER_SERVICE)).isInteractive(); }
    void startSignalService() {
        Intent svc = new Intent(this, SignalService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
    }
    void setBg(boolean on) {
        getSharedPreferences("app", MODE_PRIVATE).edit().putBoolean("bg_signals", on).apply();
        if (on) startSignalService(); else stopService(new Intent(this, SignalService.class));
    }

    WebView makeWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        w.setWebChromeClient(new WebChromeClient());
        w.setBackgroundColor(Color.parseColor("#0a0e16"));
        return w;
    }

    FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    static String mime(String f) {
        if (f.endsWith(".html")) return "text/html";
        if (f.endsWith(".js")) return "application/javascript";
        if (f.endsWith(".css")) return "text/css";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    void show(WebView w) {
        if (w != tv) closeTvPopup();
        // The signal page always stays VISIBLE (just covered): a hidden WebView gets its timers throttled or frozen,
        // then the engine stopped scanning and reconnecting while PocketOption or TradingView was shown.
        signals.setVisibility(View.VISIBLE);
        po.setVisibility(w == po ? View.VISIBLE : View.INVISIBLE);
        tv.setVisibility(w == tv ? View.VISIBLE : View.INVISIBLE);
        backBtn.setVisibility(w == signals ? View.GONE : View.VISIBLE);
        dirBadge.setVisibility(w == po && dirText != null ? View.VISIBLE : View.GONE);
        w.bringToFront(); // the visible page on top (hidden ones keep their size but get no touches)
        if (w == tv && tvPopup != null) tvPopup.bringToFront(); // an open TradingView sign-in window stays above
        backBtn.bringToFront();
        dirBadge.bringToFront();
        // Let the page redraw its chart for the now visible size.
        if (w != signals) w.postDelayed(() -> w.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null), 300);
    }

    // Ask the signal page for the switch script, then run it inside PocketOption.
    void switchPo(String name) {
        pendingPoName = null;
        signals.evaluateJavascript("window.poSwitchScript(" + JSONObject.quote(name) + ")", result -> {
            try {
                String script = new JSONArray("[" + result + "]").getString(0);
                po.evaluateJavascript(script, null);
            } catch (Exception ignored) { }
        });
    }

    @Override
    public void onBackPressed() {
        if (tvPopup != null) { closeTvPopup(); return; } // first close a TradingView sign-in window
        if (signals.getVisibility() != View.VISIBLE) show(signals);
        else moveTaskToBack(true); // keep running in the background instead of closing
    }

    class Bridge {
        @JavascriptInterface
        public boolean getBackground() { return bgOn(); }

        // Direction badge shown over PocketOption (see onCreate). up = CALL; hideSec: hide after this many seconds.
        @JavascriptInterface
        public void setDirBadge(String text, boolean up, int hideSec) {
            runOnUiThread(() -> {
                dirText = text;
                GradientDrawable b = new GradientDrawable();
                b.setColor(Color.parseColor(up ? "#F022A55B" : "#F0E5484D"));
                b.setCornerRadius(14);
                dirBadge.setBackground(b);
                dirBadge.setText(text);
                dirBadge.setVisibility(po.getVisibility() == View.VISIBLE ? View.VISIBLE : View.GONE);
                dirBadge.bringToFront();
                if (dirHide != null) dirBadge.removeCallbacks(dirHide);
                final String mine = text;
                dirHide = () -> { if (mine.equals(dirText)) { dirText = null; dirBadge.setVisibility(View.GONE); } };
                if (hideSec > 0) dirBadge.postDelayed(dirHide, hideSec * 1000L);
            });
        }

        // Double-tap switching (user, 08.11.2026): the setting, and the way back from the signals page to PocketOption.
        @JavascriptInterface
        public void setDblToggle(boolean on) { dblToggle = on; }

        @JavascriptInterface
        public void showPo() {
            runOnUiThread(() -> {
                if (!dblToggle) return;
                show(po);
                if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL);
            });
        }

        @JavascriptInterface
        public void setBackground(boolean on) { runOnUiThread(() -> setBg(on)); }

        @JavascriptInterface
        public void openPocketOption(String name, String symbol) {
            runOnUiThread(() -> {
                show(po);
                if (poLoaded && po.getUrl() != null && po.getUrl().contains("/cabinet")) switchPo(name);
                else { pendingPoName = name; if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL); }
            });
        }

        // WebSocket to PocketOption, used by the engine's 'ws' shim. Events go back to window.__wsEvent.
        @JavascriptInterface
        public void wsOpen(int id, String url) {
            PoSocket s = new PoSocket(url, PO_ORIGIN, new PoSocket.Listener() {
                public void onOpen() { js(id, "open", null); }
                public void onMessage(String text, boolean binary) { js(id, binary ? "binary" : "text", text); }
                public void onClose(String reason) { sockets.remove(id); js(id, "close", reason); }
            });
            // Look like the PocketOption page: same browser identification and its cookies for that server.
            if (poUserAgent != null) s.userAgent = poUserAgent; // read on the UI thread in onCreate
            try { s.cookies = CookieManager.getInstance().getCookie(url.replaceFirst("^wss://", "https://")); } catch (Exception ignored) { }
            sockets.put(id, s);
            s.connect();
        }

        @JavascriptInterface
        public void wsSend(int id, String text) { PoSocket s = sockets.get(id); if (s != null) s.send(text); }

        @JavascriptInterface
        public void wsClose(int id) { PoSocket s = sockets.get(id); if (s != null) s.close(); }

        // The timeframe was saved into the account chart: reload PocketOption so it takes effect, then switch the asset.
        @JavascriptInterface
        public void openPocketOptionReload(String name) {
            runOnUiThread(() -> {
                show(po);
                pendingPoName = name;
                if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL);
                else po.postDelayed(po::reload, 700); // give the server a moment to store the chart settings
            });
        }

        // Open the PocketOption tab without switching an asset (e.g. to log in).
        @JavascriptInterface
        public void showPocketOption() {
            runOnUiThread(() -> { show(po); if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL); });
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
                .setPrimaryClip(android.content.ClipData.newPlainText("PocketSignals", text)));
        }

        @JavascriptInterface
        public String getVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
        }

        // Online update: download the APK from GitHub, then hand it to Android's package installer.
        @JavascriptInterface
        public void installApk(String url) {
            if (url == null || !url.startsWith("https://github.com/")) return;
            runOnUiThread(() -> downloadAndInstall(url));
        }

        // OTC candle recording (engine._recordOtc): files/otc/<day>.csv, the newest 60 days stay.
        private java.io.File otcDir() {
            java.io.File d = new java.io.File(getFilesDir(), "otc");
            d.mkdirs();
            return d;
        }

        @JavascriptInterface
        public void recAppend(String name, String text) {
            if (name == null || text == null || !name.matches("(imp-)?\\d{4}-\\d{2}-\\d{2}\\.csv")) return;
            java.io.File dir = otcDir();
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(dir, name), true)) {
                out.write(text.getBytes("UTF-8"));
            } catch (Exception e) { return; }
            // The newest 60 days of each kind (OTC candles "<day>.csv", impulse journal "imp-<day>.csv").
            String prefix = name.startsWith("imp-") ? "imp-" : "";
            java.util.List<String> same = new java.util.ArrayList<>();
            String[] all = dir.list();
            if (all == null) return;
            for (String f : all) if (prefix.isEmpty() ? !f.startsWith("imp-") : f.startsWith(prefix)) same.add(f);
            if (same.size() <= 60) return;
            java.util.Collections.sort(same);
            for (int i = 0; i < same.size() - 60; i++) new java.io.File(dir, same.get(i)).delete();
        }

        @JavascriptInterface
        public String recInfo() {
            long bytes = 0; int days = 0;
            java.io.File[] all = otcDir().listFiles();
            if (all != null) for (java.io.File f : all) { bytes += f.length(); days++; }
            return "{\"days\":" + days + ",\"bytes\":" + bytes + "}";
        }

        // All recorded days as one zip: the Download folder (Android 10+), else the app's own external folder.
        // Returns where it went, empty on failure.
        @JavascriptInterface
        public String recExport() {
            java.io.File[] all = otcDir().listFiles();
            if (all == null || all.length == 0) return "";
            String name = "PocketSignals-OTC-" + System.currentTimeMillis() + ".zip", where;
            java.io.OutputStream raw = null;
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/zip");
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download");
                    android.net.Uri uri = getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    raw = getContentResolver().openOutputStream(uri);
                    where = "Download/" + name;
                } else {
                    java.io.File f = new java.io.File(getExternalFilesDir(null), name);
                    raw = new java.io.FileOutputStream(f);
                    where = f.getPath();
                }
                try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(raw)) {
                    byte[] buf = new byte[65536];
                    for (java.io.File f : all) {
                        zip.putNextEntry(new java.util.zip.ZipEntry(f.getName()));
                        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                            for (int n; (n = in.read(buf)) > 0; ) zip.write(buf, 0, n);
                        }
                        zip.closeEntry();
                    }
                }
                return where;
            } catch (Exception e) { return ""; }
        }

        // Demo or real trading page to open PocketOption with.
        @JavascriptInterface
        public void setPoStart(String url) {
            if (url == null || !url.matches("https://(m\\.)?pocketoption\\.com/.*")) return;
            poStart = url;
            runOnUiThread(() -> { if (po.getUrl() == null) po.loadUrl(url); });
        }

        // Text of the floating back button in the selected language.
        @JavascriptInterface
        public void setLabels(String back) {
            runOnUiThread(() -> backBtn.setText(back));
        }

        @JavascriptInterface
        public void openTradingView(String url) {
            runOnUiThread(() -> openTv(url));
        }

        // true: TradingView opens in the phone's browser / TradingView app (sign-in works there); false: inside the app.
        @JavascriptInterface
        public void setTvExternal(boolean external) { tvExternal = external; }

        // Signal notification with two buttons: "PO" opens the asset in PocketOption, "TV" in TradingView.
        @JavascriptInterface
        public void notify(String title, String body, String name, String symbol, String tvUrl) {
            notifySound(title, body, name, symbol, tvUrl, "default");
        }

        // Same, with the strategy's own sound: every sound has its own notification channel "sig_<key>" (sounds are
        // channel settings on Android 8+). "none" = silent channel, unknown key = default sound.
        @JavascriptInterface
        public void notifySound(String title, String body, String name, String symbol, String tvUrl, String key) {
            if (key == null || !key.matches("[a-z]+")) key = "default";
            int id = notifyId++;
            String ch = Build.VERSION.SDK_INT >= 26 ? "sig_" + key : CHANNEL;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(MainActivity.this, ch) : new Notification.Builder(MainActivity.this);
            if (Build.VERSION.SDK_INT < 26) {
                int raw = getResources().getIdentifier("sig_" + key, "raw", getPackageName());
                if (raw != 0) b.setSound(android.net.Uri.parse("android.resource://" + getPackageName() + "/" + raw));
            }
            // Direction at a glance (user, 03.11.2026): big green ▲ / red ▼ as the large icon, colored title and accent.
            boolean call = title != null && title.contains("CALL"), put = title != null && title.contains("PUT");
            int color = call ? 0xFF16C784 : put ? 0xFFEA3943 : 0xFF4C8DFF;
            CharSequence shown = title;
            if (call || put) {
                android.text.SpannableString sp = new android.text.SpannableString(title);
                sp.setSpan(new android.text.style.ForegroundColorSpan(color), 0, title.length(), 0);
                sp.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, title.length(), 0);
                shown = sp;
                b.setLargeIcon(arrowIcon(call, color));
            }
            b.setSmallIcon(R.drawable.ic_stat_notify).setColor(color).setContentTitle(shown).setContentText(body)
                .setAutoCancel(true).setPriority(Notification.PRIORITY_HIGH)
                .setContentIntent(actionIntent(id * 3, null, id, name, symbol, tvUrl))
                .addAction(new Notification.Action.Builder(null, (call ? "▲ " : put ? "▼ " : "") + "PO", actionIntent(id * 3 + 1, "po", id, name, symbol, tvUrl)).build())
                .addAction(new Notification.Action.Builder(null, "TV", actionIntent(id * 3 + 2, "tv", id, name, symbol, tvUrl)).build());
            getSystemService(NotificationManager.class).notify(id, b.build());
        }

        // Rounded square in the signal color with a big white arrow (large notification icon).
        private android.graphics.Bitmap arrowIcon(boolean up, int color) {
            int s = 192;
            android.graphics.Bitmap bm = android.graphics.Bitmap.createBitmap(s, s, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas cv = new android.graphics.Canvas(bm);
            android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            p.setColor(color);
            cv.drawRoundRect(new android.graphics.RectF(0, 0, s, s), 40, 40, p);
            p.setColor(Color.WHITE);
            android.graphics.Path a = new android.graphics.Path();
            if (up) { a.moveTo(s / 2f, 30); a.lineTo(s - 28, s - 50); a.lineTo(28, s - 50); }
            else { a.moveTo(s / 2f, s - 30); a.lineTo(s - 28, 50); a.lineTo(28, 50); }
            a.close();
            cv.drawPath(a, p);
            return bm;
        }

        // Older UI builds call notify with title and body only.
        @JavascriptInterface
        public void notify(String title, String body) { notify(title, body, "", "", ""); }
    }

    // Watches the PocketOption page's own socket: its 42["auth",…] message is this phone's session.
    // If the page connected before the hook was in place, the socket is closed once so it reconnects and authenticates again.
    static final String AUTH_HOOK = "(function(){if(window.__saHook)return;window.__saHook=1;var seen=false,kicked=false;"
        + "var o=WebSocket.prototype.send;WebSocket.prototype.send=function(d){"
        + "try{if(typeof d==='string'&&d.indexOf('42[\"openOrder\"')===0&&window.SignalAppAuth&&SignalAppAuth.onTrade){SignalAppAuth.onTrade('openOrder',JSON.stringify(JSON.parse(d.slice(2))[1]));}}catch(e){}"
        + "try{if(typeof d==='string'&&d.indexOf('42[\"auth\"')===0){seen=true;if(window.SignalAppAuth)SignalAppAuth.onAuth(d,String(this.url||''));}"
        + "else if(!seen&&!kicked&&location.pathname.indexOf('/cabinet')>=0){kicked=true;var s=this;setTimeout(function(){s.close();},500);}}catch(e){}"
        + "return o.apply(this,arguments);};"
        // Diagnosis: the page's own connections (server, open, close code, error) and page errors go to the app's log.
        + "var L=function(m){try{if(window.SignalAppAuth&&SignalAppAuth.onPoLog)SignalAppAuth.onPoLog(String(m).slice(0,200));}catch(e){}};"
        + "var W=window.WebSocket;window.WebSocket=function(u,p){var s=p===undefined?new W(u):new W(u,p);var h=String(u).split('/')[2]||u;"
        + "if(/po\\.market/.test(h)){var t=Date.now();s.addEventListener('open',function(){L('PO-Seite: verbunden mit '+h+' ('+(Date.now()-t)+' ms)');});"
        + "s.addEventListener('close',function(e){L('PO-Seite: getrennt von '+h+' (Code '+e.code+')');});"
        + "s.addEventListener('error',function(){L('PO-Seite: FEHLER Verbindung zu '+h);});"
        // Trade answers (opened / closed) → "My trades": a 451- frame names the event, its JSON follows as a binary frame.
        + "var pend=null,TR=/^(successopenOrder|successcloseOrder|updateClosedDeals)$/,T=function(ev,txt){try{if(window.SignalAppAuth&&SignalAppAuth.onTrade)SignalAppAuth.onTrade(ev,txt);}catch(e){}};"
        + "s.addEventListener('message',function(e){try{var d=e.data;if(typeof d==='string'){var m=/^451-\\[\"(\\w+)\"/.exec(d)||/^42\\[\"(\\w+)\"/.exec(d);"
        + "if(!m||!TR.test(m[1]))return;if(d.indexOf('451-')===0)pend=m[1];else T(m[1],JSON.stringify(JSON.parse(d.slice(2))[1]));return;}"
        + "if(!pend)return;var ev=pend;pend=null;if(d instanceof ArrayBuffer)T(ev,new TextDecoder().decode(d));else if(d&&d.text)d.text().then(function(t){T(ev,t);});}catch(x){}});}return s;};"
        + "window.WebSocket.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){window.WebSocket[k]=W[k];});"
        + "window.addEventListener('error',function(e){L('PO-Seite Fehler: '+(e.message||'?'));});"
        // Double tap on the page (two real taps within 350 ms, close together) → back to the signals (user, 08.11.2026).
        + "var lt=0,lx=0,ly=0;window.addEventListener('touchend',function(e){try{if(!e.isTrusted||e.changedTouches.length!==1)return;var t=e.changedTouches[0],n=Date.now();"
        + "if(n-lt<350&&Math.abs(t.clientX-lx)<40&&Math.abs(t.clientY-ly)<40){lt=0;if(window.SignalAppAuth&&SignalAppAuth.onDoubleTap)SignalAppAuth.onDoubleTap();}"
        + "else{lt=n;lx=t.clientX;ly=t.clientY;}}catch(x){}},true);"
        + "})();";

    String lastAuth = null;

    boolean dblToggle = true; // po_click_toggle, sent by the signal page (setDblToggle)

    class AuthBridge {
        // Double tap in the PocketOption tab → the signals page.
        @JavascriptInterface
        public void onDoubleTap() {
            if (!dblToggle) return;
            runOnUiThread(() -> { if (po.getVisibility() == View.VISIBLE) show(signals); });
        }

        // Diagnosis line from the PocketOption page (its connections, errors) → the app's connection log.
        @JavascriptInterface
        public void onPoLog(String line) {
            if (line == null) return;
            runOnUiThread(() -> signals.evaluateJavascript(
                "window.LocalEngine && window.LocalEngine.act({action:'polog',text:" + JSONObject.quote(line) + "})", null));
        }

        // Buy/Sell in the PocketOption tab and the trade's answers → engine.poTrade ("My trades").
        @JavascriptInterface
        public void onTrade(String kind, String json) {
            if (kind == null || json == null || json.length() > 200000) return;
            runOnUiThread(() -> signals.evaluateJavascript(
                "window.LocalEngine && window.LocalEngine.act({action:'trade',kind:" + JSONObject.quote(kind) + ",data:(function(){try{return JSON.parse(" + JSONObject.quote(json) + ")}catch(e){return null}})()})", null));
        }

        @JavascriptInterface
        public void onAuth(String msg, String url) {
            if (msg == null || (msg + url).equals(lastAuth) || !msg.contains("\"session\"")) return;
            lastAuth = msg + url;
            runOnUiThread(() -> signals.evaluateJavascript(
                "window.LocalEngine && window.LocalEngine.act({action:'ssid',ssid:" + JSONObject.quote(msg) + ",url:" + JSONObject.quote(url) + ",auto:true})", null));
        }
    }

    long apkDownload = -1;

    void downloadAndInstall(String url) {
        // Android 8+: the user must allow this app to install updates once ("unknown sources" for this app).
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:" + getPackageName())));
            return;
        }
        android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(android.net.Uri.parse(url))
            .setTitle("PocketSignals Update").setMimeType("application/vnd.android.package-archive")
            .setDestinationInExternalFilesDir(this, null, "PocketSignals-update-" + System.currentTimeMillis() + ".apk")
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE);
        apkDownload = dm.enqueue(req);
        android.content.BroadcastReceiver done = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context c, Intent i) {
                long id = i.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != apkDownload) return;
                unregisterReceiver(this);
                android.net.Uri apk = dm.getUriForDownloadedFile(id);
                if (apk == null) return;
                Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(apk, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(install);
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(done, f, 2 /* RECEIVER_EXPORTED: system broadcast */);
        else registerReceiver(done, f);
    }

    void js(int id, String type, String data) {
        String call = "window.__wsEvent && window.__wsEvent(" + id + "," + JSONObject.quote(type) + "," + (data == null ? "null" : JSONObject.quote(data)) + ")";
        runOnUiThread(() -> signals.evaluateJavascript(call, null));
    }

    PendingIntent actionIntent(int requestCode, String action, int notifId, String name, String symbol, String tvUrl) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("action", action).putExtra("notifId", notifId)
            .putExtra("name", name).putExtra("symbol", symbol).putExtra("tv", tvUrl);
        return PendingIntent.getActivity(this, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleAction(intent);
    }

    // Runs a notification button: switch PocketOption (and save the asset to the account) or open TradingView.
    void handleAction(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("action");
        if (action == null) return;
        getSystemService(NotificationManager.class).cancel(intent.getIntExtra("notifId", 0));
        String name = intent.getStringExtra("name"), symbol = intent.getStringExtra("symbol"), tvUrl = intent.getStringExtra("tv");
        intent.removeExtra("action");
        if ("po".equals(action) && name != null && !name.isEmpty()) {
            signals.evaluateJavascript("window.LocalEngine && window.LocalEngine.act({action:'openPO',symbol:" + JSONObject.quote(symbol) + "})", null);
            show(po);
            if (poLoaded && po.getUrl() != null && po.getUrl().contains("/cabinet")) switchPo(name);
            else pendingPoName = name;
        } else if ("tv".equals(action) && tvUrl != null && !tvUrl.isEmpty()) {
            openTv(tvUrl);
        }
    }

    volatile boolean tvExternal = true;
    WebView tvPopup = null;

    void openTv(String url) {
        if (tvExternal) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))); return; }
            catch (Exception ignored) { } // no browser/app found: fall back to the in-app view
        }
        tv.loadUrl(url);
        show(tv);
    }

    void closeTvPopup() {
        if (tvPopup == null) return;
        ((FrameLayout) tvPopup.getParent()).removeView(tvPopup);
        tvPopup.destroy();
        tvPopup = null;
    }
}
