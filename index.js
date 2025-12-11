// index.js - kimpai-price-proxy-1
// HTTP (Binance/Bybit) + WebSocket 프록시 통합 버전

const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { URL } = require("url");

// ---------------------------------------------------
// 🌡 간단 HTTP 프록시 (Binance / Bybit 전용)
// ---------------------------------------------------
function proxyHttp(req, res) {
  try {
    const originalUrl = req.url; // 예: /binance/api/v3/ticker/price?symbol=BTCUSDT

    let upstreamBase = null;
    let path = originalUrl;

    if (originalUrl.startsWith("/binance/api/")) {
      // 현물
      upstreamBase = "https://api.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/fapi/")) {
      // 선물
      upstreamBase = "https://fapi.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/bybit/")) {
      upstreamBase = "https://api.bybit.com";
      path = originalUrl.replace(/^\/bybit/, "");
    }

    if (!upstreamBase) {
      // 우리가 프록시 안 하는 경로는 그냥 “WS only” 문구만
      if (originalUrl === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: "http+ws-proxy" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("kimpai-price-proxy-1 (HTTP+WS proxy)");
      return;
    }

    const target = new URL(path, upstreamBase);

    const options = {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host, // Host 헤더 정리
      },
    };

    console.log(`[HTTP-Proxy] ${originalUrl} → ${target.href}`);

    const upstreamReq = https.request(target, options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      console.error("[HTTP-Proxy] Upstream error:", err.message || err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, error: "upstream_error" }));
    });

    // 요청 바디가 있으면 전달 (GET이면 거의 없음)
    req.pipe(upstreamReq);
  } catch (err) {
    console.error("[HTTP-Proxy] Handler error:", err.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ ok: false, error: "proxy_exception" }));
  }
}

// ---------------------------------------------------
// HTTP 서버
// ---------------------------------------------------
const server = http.createServer((req, res) => {
  proxyHttp(req, res);
});

// ---------------------------------------------------
// 🕳 WebSocket 업그레이드 (Binance/Bybit 전용)
// ---------------------------------------------------
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname, search } = url;

    let target;

    // Binance Spot - /binance/spot?streams=...
    if (pathname === "/binance/spot") {
      target = `wss://stream.binance.com:9443/stream${search}`;
    }
    // Binance Futures - /binance/futures?streams=...
    else if (pathname === "/binance/futures") {
      target = `wss://fstream.binance.com/stream${search}`;
    }
    // Bybit Spot - /bybit/spot?stream=...
    else if (pathname === "/bybit/spot") {
      target = `wss://stream.bybit.com/v5/public/spot${search}`;
    } else {
      console.warn("[WS-Proxy] Unknown path:", pathname);
      socket.destroy();
      return;
    }

    console.log(`[WS-Proxy] ${pathname} → ${target}`);

    const upstream = new WebSocket(target, {
      headers: {
        "User-Agent": "kimpai-price-proxy/1.0",
      },
    });

    const wss = new WebSocket.Server({ noServer: true });

    upstream.on("open", () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        // client → upstream
        client.on("message", (data) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data);
          }
        });

        // upstream → client
        upstream.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });

        client.on("close", () => {
          try {
            upstream.close();
          } catch (_) {}
        });

        upstream.on("close", () => {
          try {
            client.close();
          } catch (_) {}
        });

        client.on("error", (err) => {
          console.error("[WS-Proxy] Client error:", err.message || err);
          try {
            upstream.close();
          } catch (_) {}
        });

        upstream.on("error", (err) => {
          console.error("[WS-Proxy] Upstream error:", err.message || err);
          try {
            client.close();
          } catch (_) {}
        });
      });
    });

    upstream.on("error", (err) => {
      console.error("[WS-Proxy] Cannot connect upstream:", err.message || err);
      try {
        socket.destroy();
      } catch (_) {}
    });
  } catch (err) {
    console.error("[WS-Proxy] upgrade handler error:", err.message || err);
    try {
      socket.destroy();
    } catch (_) {}
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`kimpai-price-proxy-1 listening on ${PORT} (HTTP + WS proxy mode)`);
});
