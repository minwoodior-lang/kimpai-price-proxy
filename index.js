import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.json({ status: "proxy-ok", timestamp: Date.now() });
});

// 🔥 공통 요청 프록시 함수
async function proxy(url, res) {
  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

/* ============================
   국내 거래소 API 프록시
============================ */

// 업비트
app.get("/upbit/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.upbit.com/${path}`, res);
});

// 빗썸
app.get("/bithumb/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.bithumb.com/${path}`, res);
});

// 코인원
app.get("/coinone/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.coinone.co.kr/${path}`, res);
});

/* ============================
   해외 거래소 API 프록시
============================ */

// Binance (강제 바이패스용)
app.get("/binance/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.binance.com/${path}`, res);
});

// Binance Futures
app.get("/binancef/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://fapi.binance.com/${path}`, res);
});

// Bybit
app.get("/bybit/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.bybit.com/${path}`, res);
});

// OKX
app.get("/okx/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://www.okx.com/${path}`, res);
});

// Bitget
app.get("/bitget/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.bitget.com/${path}`, res);
});

// Gate
app.get("/gate/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.gateio.ws/${path}`, res);
});

// HTX (Huobi)
app.get("/htx/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.huobi.pro/${path}`, res);
});

// MEXC
app.get("/mexc/*", (req, res) => {
  const path = req.params[0];
  proxy(`https://api.mexc.com/${path}`, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy server running on port ${PORT}`));
