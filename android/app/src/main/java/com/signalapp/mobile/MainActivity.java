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
    TextView backBtn;
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
        po.setWebViewClient(new WebViewClient() {
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
        po.setVisibility(View.GONE);
        tv.setVisibility(View.GONE);

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

        setContentView(root);
        signals.loadUrl(APP_BASE + "index.html");
        // PocketOption loads once the app has said demo or real (setPoStart); fallback after 5 s.
        root.postDelayed(() -> { if (po.getUrl() == null) po.loadUrl(poStart != null ? poStart : PO_URL); }, 5000);

        handleAction(getIntent()); // app was started from a notification button

        Intent svc = new Intent(this, SignalService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
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
        signals.setVisibility(w == signals ? View.VISIBLE : View.GONE);
        po.setVisibility(w == po ? View.VISIBLE : View.GONE);
        tv.setVisibility(w == tv ? View.VISIBLE : View.GONE);
        backBtn.setVisibility(w == signals ? View.GONE : View.VISIBLE);
        backBtn.bringToFront();
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
            int id = notifyId++;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(MainActivity.this, CHANNEL) : new Notification.Builder(MainActivity.this);
            b.setSmallIcon(R.drawable.ic_stat_notify).setColor(0xFF4C8DFF).setContentTitle(title).setContentText(body)
                .setAutoCancel(true).setPriority(Notification.PRIORITY_HIGH)
                .setContentIntent(actionIntent(id * 3, null, id, name, symbol, tvUrl))
                .addAction(new Notification.Action.Builder(null, "PO", actionIntent(id * 3 + 1, "po", id, name, symbol, tvUrl)).build())
                .addAction(new Notification.Action.Builder(null, "TV", actionIntent(id * 3 + 2, "tv", id, name, symbol, tvUrl)).build());
            getSystemService(NotificationManager.class).notify(id, b.build());
        }

        // Older UI builds call notify with title and body only.
        @JavascriptInterface
        public void notify(String title, String body) { notify(title, body, "", "", ""); }
    }

    // Watches the PocketOption page's own socket: its 42["auth",…] message is this phone's session.
    // If the page connected before the hook was in place, the socket is closed once so it reconnects and authenticates again.
    static final String AUTH_HOOK = "(function(){if(window.__saHook)return;window.__saHook=1;var seen=false,kicked=false;"
        + "var o=WebSocket.prototype.send;WebSocket.prototype.send=function(d){"
        + "try{if(typeof d==='string'&&d.indexOf('42[\"auth\"')===0){seen=true;if(window.SignalAppAuth)SignalAppAuth.onAuth(d,String(this.url||''));}"
        + "else if(!seen&&!kicked&&location.pathname.indexOf('/cabinet')>=0){kicked=true;var s=this;setTimeout(function(){s.close();},500);}}catch(e){}"
        + "return o.apply(this,arguments);};})();";

    String lastAuth = null;

    class AuthBridge {
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
