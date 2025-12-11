// index.js (kimpai-price-proxy-1)
// 👉 Binance / Bybit WebSocket 전용 프록시
// 👉 HTTP 로 Binance/Bybit 호출 절대 안 함 (403/451 회피)

const http = require("http");
const WebSocket = require("ws");

// ---- HTTP 서버 (health 체크만) -----------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        ts: Date.now(),
      })
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("kimpai-price-proxy-1 (WS only)");
});

// ---- WebSocket 업그레이드 핸들러 ---------------------------
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname, search } = url;

    let target;

    // Binance Spot
    // 클라이언트: wss://kimpai-price-proxy-1.onrender.com/binance/spot?streams=...
    if (pathname === "/binance/spot") {
      target = `wss://stream.binance.com:9443/stream${search}`;
    }
    // Binance Futures
    // 클라이언트: wss://kimpai-price-proxy-1.onrender.com/binance/futures?streams=...
    else if (pathname === "/binance/futures") {
      target = `wss://fstream.binance.com/stream${search}`;
    }
    // Bybit Spot
    // 클라이언트: wss://kimpai-price-proxy-1.onrender.com/bybit/spot?stream=...
    else if (pathname === "/bybit/spot") {
      // v5 public spot endpoint
      target = `wss://stream.bybit.com/v5/public/spot${search}`;
    }
    // 필요하면 나중에 다른 거래소도 여기 추가
    else {
      console.warn("[Proxy] Unknown WS path:", pathname);
      socket.destroy();
      return;
    }

    console.log(`[Proxy] WS ${pathname} -> ${target}`);

    const upstream = new WebSocket(target, {
      headers: {
        // 약한 UA 정도만 세팅
        "User-Agent": "kimpai-price-proxy/1.0",
      },
    });

    const wss = new WebSocket.Server({ noServer: true });

    upstream.on("open", () => {
      // 클라이언트와 업스트림 사이에 투명 터널 생성
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

        upstream.on("error", (err) => {
          console.error("[Proxy] Upstream error:", err.message || err);
          try {
            client.close();
          } catch (_) {}
        });

        client.on("error", (err) => {
          console.error("[Proxy] Client error:", err.message || err);
          try {
            upstream.close();
          } catch (_) {}
        });
      });
    });

    upstream.on("error", (err) => {
      console.error("[Proxy] Cannot connect upstream:", err.message || err);
      try {
        socket.destroy();
      } catch (_) {}
    });
  } catch (err) {
    console.error("[Proxy] upgrade handler error:", err.message || err);
    try {
      socket.destroy();
    } catch (_) {}
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`kimpai-price-proxy-1 listening on ${PORT} (WS only mode)`);
});
