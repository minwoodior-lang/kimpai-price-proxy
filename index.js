// index.js - kimpai-price-proxy-1
// HTTP (Binance/Bybit) + WebSocket proxy
// ✅ 헤더 정리/압축 해제/디버그 엔드포인트 포함

const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

/** ------------------------------------------------------------------
 * Header sanitization
 * - upstream(특히 binance fapi)에서 차단 트리거 되는 헤더 제거
 * ------------------------------------------------------------------ */
function buildUpstreamHeaders(req, targetHost) {
  const h = { ...req.headers };

  // hop-by-hop / proxy / cf / forwarded / browser-origin 계열 제거
  const dropPrefixes = [
    "cf-",
    "x-forwarded-",
    "x-real-",
    "forwarded",
    "sec-",
  ];

  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (
      lk === "host" ||
      lk === "connection" ||
      lk === "content-length" ||
      lk === "accept-encoding" ||
      lk === "origin" ||
      lk === "referer" ||
      lk === "upgrade" ||
      lk === "proxy-connection" ||
      lk === "te" ||
      lk === "trailer" ||
      lk === "transfer-encoding" ||
      lk === "keep-alive"
    ) {
      delete h[k];
      continue;
    }
    if (dropPrefixes.some((p) => lk.startsWith(p))) {
      delete h[k];
    }
  }

  // upstream 고정 헤더 (압축 off / UA 고정)
  h["host"] = targetHost;
  h["accept"] = h["accept"] || "application/json,text/plain,*/*";
  h["accept-language"] = h["accept-language"] || "en-US,en;q=0.9";
  h["accept-encoding"] = "identity";
  h["user-agent"] =
    h["user-agent"] || "kimpai-price-proxy/1.0 (+https://kimpai.io)";
  h["connection"] = "close";

  return h;
}

/** ------------------------------------------------------------------
 * Simple helpers
 * ------------------------------------------------------------------ */
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readStreamAsText(stream, limit = 4000) {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (c) => {
      if (buf.length < limit) buf += c.toString("utf8");
    });
    stream.on("end", () => resolve(buf));
    stream.on("error", () => resolve(buf));
  });
}

/** ------------------------------------------------------------------
 * HTTP Proxy (Binance/Bybit)
 * ------------------------------------------------------------------ */
function resolveUpstream(originalUrl) {
  // NOTE: path는 /binance 를 제거해서 upstream에 그대로 붙임
  if (originalUrl.startsWith("/binance/api/")) {
    return { base: "https://api.binance.com", path: originalUrl.replace(/^\/binance/, "") };
  }
  if (originalUrl.startsWith("/binance/fapi/")) {
    return { base: "https://fapi.binance.com", path: originalUrl.replace(/^\/binance/, "") };
  }
  if (originalUrl.startsWith("/binance/futures/data/")) {
    // ex) /binance/futures/data/globalLongShortAccountRatio?...
    // 공식은 fapi.binance.com/futures/data/...
    return { base: "https://fapi.binance.com", path: originalUrl.replace(/^\/binance/, "") };
  }
  if (originalUrl.startsWith("/bybit/")) {
    return { base: "https://api.bybit.com", path: originalUrl.replace(/^\/bybit/, "") };
  }
  return null;
}

async function proxyHttp(req, res) {
  try {
    const originalUrl = req.url;

    // health / debug
    if (originalUrl === "/health") {
      return sendJson(res, 200, { ok: true, mode: "http+ws-proxy" });
    }
    if (originalUrl === "/debug/ip") {
      // Render에서 보이는 클라이언트 IP 확인용
      const ip =
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress ||
        null;
      return sendJson(res, 200, { ip });
    }

    const resolved = resolveUpstream(originalUrl);
    if (!resolved) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("kimpai-price-proxy-1 (HTTP+WS proxy)");
      return;
    }

    const target = new URL(resolved.path, resolved.base);
    const headers = buildUpstreamHeaders(req, target.host);

    const options = {
      method: req.method,
      headers,
      timeout: 15000,
    };

    console.log(`[HTTP-Proxy] ${req.method} ${originalUrl} → ${target.href}`);

    const upstreamReq = https.request(target, options, async (upstreamRes) => {
      // 403/HTML 등 디버깅을 위해 일부 바디를 로그로 남김 (너가 이미 찍고있던 부분 유지)
      const ct = (upstreamRes.headers["content-type"] || "").toLowerCase();
      const status = upstreamRes.statusCode || 500;

      // upstream headers 그대로 주면 content-encoding 꼬일 수 있어서, 압축 꺼둔 상태지만 안전하게 정리
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders["content-encoding"];
      delete outHeaders["content-length"]; // pipe하면 자동 처리

      res.writeHead(status, outHeaders);

      // 403인데 HTML이면 로그용으로만 조금 읽고, 실제 응답은 그대로 흘려보냄
      if (status === 403 && ct.includes("text/html")) {
        const peek = await readStreamAsText(upstreamRes, 1200);
        console.log(
          `[HTTP-Proxy][UPSTREAM_BODY] 403 ${originalUrl} :: ${peek.replace(/\s+/g, " ").slice(0, 900)}`
        );
        // 이미 일부 읽었으니 클라이언트에는 “친절한 JSON”으로 반환(프론트에서 처리 쉬움)
        // (원하면 이 부분 주석 처리하고 HTML 그대로 넘겨도 됨)
        if (!res.headersSent) {
          return sendJson(res, 403, {
            ok: false,
            error: "blocked_by_upstream",
            upstream: target.host,
          });
        }
        return;
      }

      upstreamRes.pipe(res);
    });

    upstreamReq.on("timeout", () => {
      console.error("[HTTP-Proxy] Upstream timeout:", target.href);
      upstreamReq.destroy(new Error("timeout"));
    });

    upstreamReq.on("error", (err) => {
      console.error("[HTTP-Proxy] Upstream error:", err.message || err);
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: "upstream_error" });
      else {
        try { res.end(); } catch (_) {}
      }
    });

    // body forward
    req.pipe(upstreamReq);
  } catch (err) {
    console.error("[HTTP-Proxy] Handler error:", err.message || err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "proxy_exception" });
    else {
      try { res.end(); } catch (_) {}
    }
  }
}

/** ------------------------------------------------------------------
 * HTTP server
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => proxyHttp(req, res));

/** ------------------------------------------------------------------
 * WebSocket upgrade proxy
 * ------------------------------------------------------------------ */
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
      headers: { "User-Agent": "kimpai-price-proxy/1.0" },
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
          console.error("[WS-Proxy] Client error:", err.message || err);
          try { upstream.close(); } catch (_) {}
        });

        upstream.on("error", (err) => {
          console.error("[WS-Proxy] Upstream error:", err.message || err);
          try { client.close(); } catch (_) {}
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
