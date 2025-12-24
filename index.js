// index.js - kimpai-price-proxy-1
// HTTP (Binance/Bybit) + WebSocket 프록시 통합 버전 (hardened)

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
      // Binance Spot REST
      upstreamBase = "https://api.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/fapi/")) {
      // Binance Futures REST (/fapi/v1, /fapi/v2 ...)
      upstreamBase = "https://fapi.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/futures/data/")) {
      // ✅ Binance Futures Data (롱/숏 ratio, OI hist 등)
      upstreamBase = "https://fapi.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/bybit/")) {
      // Bybit REST
      upstreamBase = "https://api.bybit.com";
      path = originalUrl.replace(/^\/bybit/, "");
    }

    // health / default
    if (!upstreamBase) {
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

    // --- Build safe headers ---
    // 1) hop-by-hop 헤더 제거
    // 2) host는 우리가 세팅하지 않음 (https.request가 target 기준으로 정리)
    const incomingHeaders = { ...req.headers };
    delete incomingHeaders.host;
    delete incomingHeaders.connection;
    delete incomingHeaders["proxy-connection"];
    delete incomingHeaders["keep-alive"];
    delete incomingHeaders["transfer-encoding"];
    delete incomingHeaders.te;
    delete incomingHeaders.trailer;
    delete incomingHeaders.upgrade;

    // 3) UA 없으면 넣기 (일부 WAF/엣지에서 필요)
    if (!incomingHeaders["user-agent"]) {
      incomingHeaders["user-agent"] = "Mozilla/5.0 (kimpai-price-proxy)";
    }

    const options = {
      method: req.method,
      headers: incomingHeaders,
    };

    const startedAt = Date.now();
    console.log(`[HTTP-Proxy] ${req.method} ${originalUrl} → ${target.href}`);

    const upstreamReq = https.request(target, options, (upstreamRes) => {
      const ms = Date.now() - startedAt;
      const status = upstreamRes.statusCode || 500;

      // --- Response headers sanitize ---
      // CloudFront/Edge에서 문제 만드는 헤더들을 최소화
      const outHeaders = { ...upstreamRes.headers };

      // hop-by-hop 제거
      delete outHeaders.connection;
      delete outHeaders["proxy-connection"];
      delete outHeaders["keep-alive"];
      delete outHeaders["transfer-encoding"];
      delete outHeaders.te;
      delete outHeaders.trailer;
      delete outHeaders.upgrade;

      // 경우에 따라 압축/길이 꼬이면 엣지가 403 내는 경우가 있어 안전 처리
      // (binance는 보통 gzip 쓰는데, 그대로 전달해도 되지만 문제 시 여기서 정리)
      // 필요하면 주석 해제:
      // delete outHeaders["content-encoding"];

      console.log(
        `[HTTP-Proxy] ← ${status} ${req.method} ${originalUrl} (${ms}ms)`
      );

      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      console.error("[HTTP-Proxy] Upstream error:", err && (err.stack || err.message || err));
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, error: "upstream_error" }));
    });

    // request body forward
    req.pipe(upstreamReq);
  } catch (err) {
    console.error("[HTTP-Proxy] Handler error:", err && (err.stack || err.message || err));
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
        client.on("message", (data) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        });

        upstream.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(data);
        });

        client.on("close", () => {
          try { upstream.close(); } catch (_) {}
        });

        upstream.on("close", () => {
          try { client.close(); } catch (_) {}
        });

        client.on("error", (err) => {
          console.error("[WS-Proxy] Client error:", err && (err.message || err));
          try { upstream.close(); } catch (_) {}
        });

        upstream.on("error", (err) => {
          console.error("[WS-Proxy] Upstream error:", err && (err.message || err));
          try { client.close(); } catch (_) {}
        });
      });
    });

    upstream.on("error", (err) => {
      console.error("[WS-Proxy] Cannot connect upstream:", err && (err.message || err));
      try { socket.destroy(); } catch (_) {}
    });
  } catch (err) {
    console.error("[WS-Proxy] upgrade handler error:", err && (err.stack || err.message || err));
    try { socket.destroy(); } catch (_) {}
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`kimpai-price-proxy-1 listening on ${PORT} (HTTP + WS proxy mode)`);
});
