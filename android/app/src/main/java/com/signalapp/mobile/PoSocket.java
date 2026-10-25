package com.signalapp.mobile;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal WebSocket client (RFC 6455) so the app can send the Origin header PocketOption requires,
 * independent of the page's own address. Text and binary frames are both delivered as UTF-8 text.
 */
class PoSocket {
    interface Listener {
        void onOpen();
        void onMessage(String text, boolean binary);
        void onClose(String reason);
    }

    private final String url, origin;
    private final Listener listener;
    String userAgent = "Mozilla/5.0 (Linux; Android) PocketSignals";
    String cookies = null; // cookies the PocketOption page has for this server
    private Socket socket;
    private OutputStream out;
    private volatile boolean closed = false;
    private final SecureRandom rnd = new SecureRandom();

    PoSocket(String url, String origin, Listener listener) {
        this.url = url;
        this.origin = origin;
        this.listener = listener;
    }

    void connect() {
        new Thread(this::run, "po-socket").start();
    }

    private void run() {
        try {
            URI u = URI.create(url);
            boolean tls = "wss".equals(u.getScheme());
            int port = u.getPort() > 0 ? u.getPort() : (tls ? 443 : 80);
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(u.getHost(), port), 15000);
            socket = tls ? ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, u.getHost(), port, true) : raw;
            if (socket instanceof SSLSocket) ((SSLSocket) socket).startHandshake();
            out = socket.getOutputStream();
            InputStream in = socket.getInputStream();

            byte[] keyBytes = new byte[16];
            rnd.nextBytes(keyBytes);
            String key = Base64.encodeToString(keyBytes, Base64.NO_WRAP);
            String path = u.getRawPath() + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
            String req = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + u.getHost() + "\r\n"
                + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n"
                + "Origin: " + origin + "\r\n"
                + "User-Agent: " + userAgent + "\r\n"
                + (cookies != null && !cookies.isEmpty() ? "Cookie: " + cookies + "\r\n" : "")
                + "\r\n";
            out.write(req.getBytes(StandardCharsets.UTF_8));
            out.flush();

            String status = readLine(in);
            if (status == null || !status.contains(" 101")) throw new IOException("Handshake: " + status);
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) { /* skip headers */ }
            listener.onOpen();
            readFrames(in);
        } catch (Exception e) {
            if (!closed) listener.onClose(e.getClass().getSimpleName() + ": " + e.getMessage());
            closed = true;
            return;
        }
        if (!closed) listener.onClose("closed");
        closed = true;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("EOF");
            off += n;
        }
    }

    private void readFrames(InputStream in) throws IOException {
        ByteArrayOutputStream msg = new ByteArrayOutputStream();
        int msgOp = 0;
        while (!closed) {
            int b0 = in.read(), b1 = in.read();
            if (b0 < 0 || b1 < 0) return;
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0F;
            long len = b1 & 0x7F;
            if (len == 126) { byte[] l = new byte[2]; readFully(in, l); len = ((l[0] & 0xFF) << 8) | (l[1] & 0xFF); }
            else if (len == 127) { byte[] l = new byte[8]; readFully(in, l); len = 0; for (byte x : l) len = (len << 8) | (x & 0xFF); }
            byte[] mask = null;
            if ((b1 & 0x80) != 0) { mask = new byte[4]; readFully(in, mask); }
            byte[] data = new byte[(int) len];
            readFully(in, data);
            if (mask != null) for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];

            if (op == 0x8) return;                       // close
            if (op == 0x9) { sendFrame(0xA, data); continue; } // ping -> pong
            if (op == 0xA) continue;                     // pong
            if (op == 0x1 || op == 0x2) { msg.reset(); msgOp = op; }
            msg.write(data);
            if (fin) listener.onMessage(msg.toString("UTF-8"), msgOp == 0x2);
        }
    }

    private synchronized void sendFrame(int op, byte[] data) throws IOException {
        if (out == null) return;
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        f.write(0x80 | op);
        if (data.length < 126) f.write(0x80 | data.length);
        else if (data.length < 65536) { f.write(0x80 | 126); f.write(data.length >> 8); f.write(data.length & 0xFF); }
        else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) data.length >> (8 * i)) & 0xFF)); }
        byte[] mask = new byte[4];
        rnd.nextBytes(mask);
        f.write(mask);
        for (int i = 0; i < data.length; i++) f.write(data[i] ^ mask[i % 4]);
        out.write(f.toByteArray());
        out.flush();
    }

    void send(String text) {
        new Thread(() -> {
            try { sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8)); }
            catch (IOException e) { close(); }
        }).start();
    }

    void close() {
        if (closed) return;
        closed = true;
        new Thread(() -> {
            try { sendFrame(0x8, new byte[0]); } catch (IOException ignored) { }
            try { if (socket != null) socket.close(); } catch (IOException ignored) { }
            listener.onClose("closed");
        }).start();
    }
}
