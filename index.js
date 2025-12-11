// index.js
// ------------------------------
// KimpAI Price Proxy Server
// Render 전용 서비스
// 1) 가격 프록시(API 우회)
// 2) Binance TOP100 심볼 제공 API
// ------------------------------

const express = require("express");
const cors = require("cors");
const axios = require("axios");

// TOP100 심볼 생성 모듈
const { fetchTop100Symbols } = require("./topSymbols");

const app = express();
app.use(cors());

// --------------------------------------------------------
// 1) 기본 라우트 (health check 용)
// --------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "kimpai-price-proxy",
    message: "Price Proxy Running",
  });
});

// --------------------------------------------------------
// 2) 가격 프록시 (기존 기능 유지 가능)
// ※ 필요한 경우 여기로 원하는 API 우회 추가 가능
// --------------------------------------------------------
app.get("/proxy", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ ok: false, error: "url query required" });
  }

  try {
    const response = await axios.get(url, { timeout: 5000 });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// --------------------------------------------------------
// 3) ⭐ Binance TOP100 심볼 제공 API (Railway / Replit 공용)
// --------------------------------------------------------
app.get("/api/internal/top-symbols", async (req, res) => {
  try {
    const symbols = await fetchTop100Symbols();

    if (!symbols || symbols.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "Failed to fetch symbols",
      });
    }

    return res.json({
      ok: true,
      count: symbols.length,
      symbols,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// --------------------------------------------------------
// 서버 시작
// --------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ kimpai-price-proxy running on port ${PORT}`);
});
