// index.js
// kimpai-price-proxy v1.1
// - /api/internal/top-symbols : Binance 24h ticker 기반 TOP 100 USDT 심볼
// - /binance/*                : https://api.binance.com/* 프록시
// - /bybit/*                  : https://api.bybit.com/* 프록시

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const {
  fetchTop100Symbols,
  getTopSymbolsSync,
} = require("./topSymbols");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 헬스체크
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "kimpai-price-proxy",
    uptime: process.uptime(),
    now: new Date().toISOString(),
  });
});

// 내부용 TOP 심볼 API
app.get("/api/internal/top-symbols", async (req, res) => {
  try {
    const force = req.query.force === "1";

    let symbols;
    if (force) {
      symbols = await fetchTop100Symbols();
    } else {
      // 캐시가 있으면 캐시, 없으면 fetch
      const cached = getTopSymbolsSync();
      if (cached && cached.length > 0) {
        symbols = cached;
      } else {
        symbols = await fetchTop100Symbols();
      }
    }

    res.json({
      ok: true,
      count: symbols.length,
      symbols,
    });
  } catch (err) {
    console.error("[Proxy] /api/internal/top-symbols error:", err.message);
    res.status(500).json({
      ok: false,
      error: err.message || "internal error",
    });
  }
});

// 공통 프록시 헬퍼
async function proxyRequest(baseUrl, req, res) {
  try {
    const targetPath = req.originalUrl.replace(/^\/(binance|bybit)/, "");
    const url = baseUrl + targetPath;

    const config = {
      method: req.method,
      url,
      params: req.query,
      data: req.body,
      timeout: 8000,
      headers: {
        "User-Agent": "kimpai-price-proxy/1.0",
      },
    };

    const resp = await axios(config);

    // content-type 그대로 전달
    if (resp.headers["content-type"]) {
      res.setHeader("content-type", resp.headers["content-type"]);
    }
    res.status(resp.status).send(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error(
      `[Proxy] ${baseUrl} error:`,
      status,
      err.response?.data || err.message
    );
    res.status(status).json({
      ok: false,
      proxy: baseUrl.includes("binance")
        ? "binance"
        : baseUrl.includes("bybit")
        ? "bybit"
        : "unknown",
      status,
      message: err.response?.data || err.message,
    });
  }
}

// Binance REST 프록시 (/binance/ 이하 전부)
app.use("/binance", (req, res) => {
  proxyRequest("https://api.binance.com", req, res);
});

// Bybit REST 프록시 (/bybit/ 이하 전부)
app.use("/bybit", (req, res) => {
  proxyRequest("https://api.bybit.com", req, res);
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not Found",
    path: req.originalUrl,
  });
});

app.listen(PORT, () => {
  console.log(`kimpai-price-proxy running on port ${PORT}`);
});
