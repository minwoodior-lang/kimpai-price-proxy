// index.js - kimpai-price-proxy-1
// HTTP (Binance/Bybit) + WebSocket 프록시 통합 버전 (hardened + debug)

const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { URL } = require("url");

// ---------------------------------------------------
// 🌡 간단 HTTP 프록시 (Binance / Bybit 전용)
// ---------------------------------------------------
function proxyHttp(req, res) {
  try {
    const originalUrl = req.url;

    // --- Debug: egress IP 확인 (Shell 없어도 확인 가능) ---
    if (originalUrl === "/debug/ip") {
      https
        .get("https://api.ipify.org?format=json", (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(data);
          });
        })
        .on("error", (e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "ip_lookup_failed" }));
        });
      return;
    }

    let upstreamBase = null;
    let path = originalUrl;

    if (originalUrl.startsWith("/binance/api/")) {
      // Binance Spot REST
      upstreamBase = "https://api.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/fapi/")) {
      // Binance Futures REST
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

    // --- Build safe request headers ---
    const incomingHeaders = { ...req.headers };

    // hop-by-hop 제거
    delete incomingHeaders.host;
    delete incomingHeaders.connection;
    delete incomingHeaders["proxy-connection"];
    delete incomingHeaders["keep-alive"];
    delete incomingHeaders["transfer-encoding"];
    delete incomingHeaders.te;
    delete incomingHeaders.trailer;
    delete incomingHeaders.upgrade;

    // UA 없으면 추가
    if (!incomingHeaders["user-agent"]) {
      incomingHeaders["user-agent"] = "Mozilla/5.0 (kimpai-price-proxy)";
    }

    // ✅ Futures 계열은 WAF/차단 회피용 브라우저 헤더 강제
    const isBinanceFutures =
      originalUrl.startsWith("/binance/fapi/") ||
      originalUrl.startsWith("/binance/futures/data/");
    if (isBinanceFutures) {
      incomingHeaders["accept"] = incomingHeaders["accept"] || "*/*";
      incomingHeaders["accept-language"] =
        incomingHeaders["accept-language"] || "en-US,en;q=0.9";
      incomingHeaders["cache-control"] = "no-cache";
      incomingHeaders["pragma"] = "no-cache";
      incomingHeaders["referer"] = "https://www.binance.com/";
      incomingHeaders["origin"] = "https://www.binance.com";
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

      // ✅ 4xx/5xx면 upstream body 일부를 로그에 찍어서 원인 확정
      if (status >= 400) {
        let buf = "";
        upstreamRes.on("data", (chunk) => {
          if (buf.length < 2000) buf += chunk.toString("utf8");
        });
        upstreamRes.on("end", () => {
          console.log(
            `[HTTP-Proxy][UPSTREAM_BODY] ${status} ${originalUrl} :: ${buf
              .slice(0, 500)
              .replace(/\s+/g, " ")}`
          );
        });
      }

      // --- Response headers sanitize ---
      const outHeaders = { ...upstreamRes.headers };

      // hop-by-hop 제거
      delete outHeaders.connection;
      delete outHeaders["proxy-connection"];
      delete outHeaders["keep-alive"];
      delete outHeaders["transfer-encoding"];
      delete outHeaders.te;
      delete outHeaders.trailer;
      delete outHeaders.upgrade;

      // 필요 시 압축 제거(문제 계속되면 주석 해제)
      // delete outHeaders["content-encoding"];

      console.log(
        `[HTTP-Proxy] ← ${status} ${req.method} ${originalUrl} (${ms}ms)`
      );

      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      console.error(
        "[HTTP-Proxy] Upstream error:",
        err && (err.stack || err.message || err)
      );
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, error: "upstream_error" }));
    });

    req.pipe(upstreamReq);
  } catch (err) {
    console.error(
      "[HTTP-Proxy] Handler error:",
      err && (err.stack || err.message || err)
    );
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

    if (pathname === "/binance/spot") {
      target = `wss://stream.binance.com:9443/stream${search}`;
    } else if (pathname === "/binance/futures") {
      target = `wss://fstream.binance.com/stream${search}`;
    } else if (pathname === "/bybit/spot") {
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
          console.error("[WS-Proxy] Client error:", err && (err.message || err));
          try {
            upstream.close();
          } catch (_) {}
        });

        upstream.on("error", (err) => {
          console.error(
            "[WS-Proxy] Upstream error:",
            err && (err.message || err)
          );
          try {
            client.close();
          } catch (_) {}
        });
      });
    });

    upstream.on("error", (err) => {
      console.error(
        "[WS-Proxy] Cannot connect upstream:",
        err && (err.message || err)
      );
      try {
        socket.destroy();
      } catch (_) {}
    });
  } catch (err) {
    console.error(
      "[WS-Proxy] upgrade handler error:",
      err && (err.stack || err.message || err)
    );
    try {
      socket.destroy();
    } catch (_) {}
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(
    `kimpai-price-proxy-1 listening on ${PORT} (HTTP + WS proxy mode)`
  );
});
