/** 
 * KimpAI Proxy + WebSocket Relay Unified Server
 * Full REST Proxy + WebSocket Bypass (Binance / Bybit / Gate / MEXC)
 */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

/* ============================
   CACHE + RATE LIMIT HANDLING
============================ */

const PRICE_CACHE_TTL = 2000;
const STATS_CACHE_TTL = 5000;
const STALE_CACHE_TTL = 60000;
const cache = new Map();
const rateLimitTracker = new Map();

function getCached(key, ttl = PRICE_CACHE_TTL, allowStale = false) {
  const item = cache.get(key);
  if (!item) return null;

  const age = Date.now() - item.ts;
  if (age < ttl) return { data: item.data, isStale: false };
  if (allowStale && age < STALE_CACHE_TTL) return { data: item.data, isStale: true };
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function recordRateLimit(endpoint) {
  const now = Date.now();
  if (!rateLimitTracker.has(endpoint)) rateLimitTracker.set(endpoint, []);
  const times = rateLimitTracker.get(endpoint);
  times.push(now);
  rateLimitTracker.set(endpoint, times.filter(t => now - t < 60000));
}

/* ============================
   BASIC HEALTH CHECK
============================ */
app.get("/", (req, res) => {
  res.json({ status: "proxy-ok", timestamp: new Date().toISOString() });
});

app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    mode: "REST + WebSocket Relay",
    timestamp: new Date().toISOString()
  });
});

/* ============================
     REST API PROXY (기존 유지)
============================ */

async function proxyRequest(url, cacheKey, ttl, req, res) {
  try {
    let cached = getCached(cacheKey, ttl, true);
    let data = cached?.data;

    if (!data) {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      data = response.data;
      setCache(cacheKey, data);
    }

    return res.json(data);
  } catch (error) {
    console.error("Proxy error:", error.message);
    return res.status(500).json({ error: "Proxy failed" });
  }
}

/* Binance Spot Price */
app.get("/binance/api/v3/ticker/price", (req, res) =>
  proxyRequest(
    "https://api.binance.com/api/v3/ticker/price",
    "binance_spot_price",
    PRICE_CACHE_TTL,
    req,
    res
  )
);

/* Binance Futures Price */
app.get("/binance/fapi/v1/ticker/price", (req, res) =>
  proxyRequest(
    "https://fapi.binance.com/fapi/v1/ticker/price",
    "binance_futures_price",
    PRICE_CACHE_TTL,
    req,
    res
  )
);

/* Binance Spot 24hr */
app.get("/binance/api/v3/ticker/24hr", (req, res) =>
  proxyRequest(
    "https://api.binance.com/api/v3/ticker/24hr",
    "binance_spot_24hr",
    STATS_CACHE_TTL,
    req,
    res
  )
);

/* Binance Futures 24hr */
app.get("/binance/fapi/v1/ticker/24hr", (req, res) =>
  proxyRequest(
    "https://fapi.binance.com/fapi/v1/ticker/24hr",
    "binance_futures_24hr",
    STATS_CACHE_TTL,
    req,
    res
  )
);

/* Bybit REST */
app.get("/bybit/v5/market/tickers", (req, res) => {
  const category = req.query.category || "spot";
  proxyRequest(
    `https://api.bybit.com/v5/market/tickers?category=${category}`,
    `bybit_${category}`,
    PRICE_CACHE_TTL,
    req,
    res
  );
});

/* ============================
   WEBSOCKET RELAY (우회 적용)
============================ */

function createRelay(path, targetUrl) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === path) {
      wss.handleUpgrade(req, socket, head, (client) => {
        const exchange = new WebSocket(targetUrl);

        exchange.on("open", () => {
          console.log(`[WS-RELAY] CONNECTED → ${targetUrl}`);
        });

        exchange.on("message", (msg) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        });

        exchange.on("close", () => client.close());
        exchange.on("error", () => client.close());
        client.on("close", () => exchange.close());
      });
    }
  });
}

/* Binance Spot */
createRelay("/ws/binance/spot", "wss://stream.binance.com:9443/ws/!ticker@arr");

/* Binance Futures */
createRelay("/ws/binance/futures", "wss://fstream.binance.com/ws/!ticker@arr");

/* Bybit (spot + futures 혼합) */
createRelay("/ws/bybit", "wss://stream.bybit.com/v5/public/spot");

createRelay("/ws/mexc", "wss://wbs.mexc.com/ws");
createRelay("/ws/gate", "wss://api.gateio.ws/ws/v4/");

/* ============================
      START SERVER
============================ */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("==============================================");
  console.log(`KimpAI PROXY + WS RELAY running on port ${PORT}`);
  console.log("==============================================");
});
