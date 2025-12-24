// index.js - kimpai-price-proxy-1
// HTTP (Binance/Bybit) + WebSocket proxy
// - 헤더 최소화 (WAF 트리거 완화)
// - keep-alive agent
// - /health, /debug/ip

const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30_000,
});

function pickHeaders(req) {
  // ✅ 업스트림에 “필요한 것만” 보냄 (브라우저 sec-ch-ua 등 제거)
  const h = req.headers || {};
  const out = {
    // CloudFront/WAF에 가장 영향 큰 UA 고정
    "user-agent":
      h["user-agent"] ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    accept: h["accept"] || "application/json,text/plain,*/*",
    "accept-language": h["accept-language"] || "en-US,en;q=0.9,ko;q=0.8",
    // gzip 허용 (응답은 그대로 pipe)
    "accept-encoding": h["accept-encoding"] || "gzip, deflate, br",
    connection: "keep-alive",
  };

  // content-type 등은 필요시만
  if (h["content-type"]) out["content-type"] = h["content-type"];
  if (h["cache-control"]) out["cache-control"] = h["cache-control"];
  if (h["pragma"]) out["pragma"] = h["pragma"];

  return out;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function proxyHttp(req, res) {
  try {
    const originalUrl = req.url;

    // ---- 내부 엔드포인트 ----
    if (originalUrl === "/" || originalUrl === "/__") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("kimpai-price-proxy-1 (HTTP+WS proxy)");
      return;
    }

    if (originalUrl === "/health") {
      sendJson(res, 200, { ok: true, mode: "http+ws-proxy", ts: Date.now() });
      return;
    }

    if (originalUrl === "/debug/ip") {
      // 인바운드 규칙이 아니라는 걸 보여주려고 추가
      const ip =
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress ||
        "";
      sendJson(res, 200, { ip });
      return;
    }

    // ---- 업스트림 라우팅 ----
    let upstreamBase = null;
    let path = originalUrl;

    if (originalUrl.startsWith("/binance/api/")) {
      upstreamBase = "https://api.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/fapi/")) {
      upstreamBase = "https://fapi.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/binance/futures/data/")) {
      upstreamBase = "https://fapi.binance.com";
      path = originalUrl.replace(/^\/binance/, "");
    } else if (originalUrl.startsWith("/bybit/")) {
      upstreamBase = "https://api.bybit.com";
      path = originalUrl.replace(/^\/bybit/, "");
    }

    if (!upstreamBase) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const target = new URL(path, upstreamBase);

    const options = {
      method: req.method,
      agent: keepAliveAgent,
      headers: {
        ...pickHeaders(req),
        host: target.host, // Host 헤더는 업스트림 기준으로
      },
      timeout: 20_000,
    };

    console.log(`[HTTP-Proxy] ${req.method} ${originalUrl} → ${target.href}`);

    const upstreamReq = https.request(target, options, (upstreamRes) => {
      // 상태/헤더 그대로 내려주되, content-encoding 등은 유지
      res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);

      // 비정상 응답이면 바디 앞부분만 로깅 (원인 확인용)
      if ((upstreamRes.statusCode || 0) >= 400) {
        let buf = "";
        upstreamRes.on("data", (chunk) => {
          if (buf.length < 2000) buf += chunk.toString("utf8");
        });
        upstreamRes.on("end", () => {
          console.log(
            `[HTTP-Proxy][UPSTREAM_BODY] ${upstreamRes.statusCode} ${originalUrl} :: ${buf.replace(/\s+/g, " ").slice(0, 1800)}`
          );
        });
      }

      upstreamRes.pipe(res);
    });

    upstreamReq.on("timeout", () => {
      console.error("[HTTP-Proxy] Upstream timeout:", target.href);
      upstreamReq.destroy(new Error("upstream_timeout"));
    });

    upstreamReq.on("error", (err) => {
      console.error("[HTTP-Proxy] Upstream error:", err.message || err);
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: "upstream_error" });
      } else {
        try { res.end(); } catch (_) {}
      }
    });

    // 바디 전달
    req.pipe(upstreamReq);
  } catch (err) {
    console.error("[HTTP-Proxy] Handler error:", err.message || err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "proxy_exception" });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
}

// HTTP 서버
const server = http.createServer(proxyHttp);

// WebSocket upgrade
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
        "User-Agent": "Mozilla/5.0 (kimpai-price-proxy)",
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

        const closeBoth = () => {
          try { client.close(); } catch (_) {}
          try { upstream.close(); } catch (_) {}
        };

        client.on("close", closeBoth);
        upstream.on("close", closeBoth);

        client.on("error", (err) => {
          console.error("[WS-Proxy] Client error:", err.message || err);
          closeBoth();
        });

        upstream.on("error", (err) => {
          console.error("[WS-Proxy] Upstream error:", err.message || err);
          closeBoth();
        });
      });
    });

    upstream.on("error", (err) => {
      console.error("[WS-Proxy] Cannot connect upstream:", err.message || err);
      try { socket.destroy(); } catch (_) {}
    });
  } catch (err) {
    console.error("[WS-Proxy] upgrade handler error:", err.message || err);
    try { socket.destroy(); } catch (_) {}
  }
});

server.listen(PORT, () => {
  console.log(`kimpai-price-proxy-1 listening on ${PORT} (HTTP + WS proxy mode)`);
});
