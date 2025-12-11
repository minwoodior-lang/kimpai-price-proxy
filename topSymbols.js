// topSymbols.js
const axios = require("axios");

// Binance 24h ticker 기반 TOP100
async function fetchTop100Symbols() {
  try {
    const res = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr",
      { timeout: 7000 }
    );

    const rows = res.data;

    const usdtRows = rows.filter(
      (r) =>
        r.symbol &&
        r.symbol.endsWith("USDT") &&
        !r.symbol.includes("UP") &&
        !r.symbol.includes("DOWN")
    );

    const sorted = usdtRows
      .map((r) => ({
        symbol: r.symbol.toLowerCase(),
        quoteVolume: parseFloat(r.quoteVolume || "0"),
        lastPrice: parseFloat(r.lastPrice || "0"),
      }))
      .filter((r) => r.quoteVolume > 0 && r.lastPrice > 0)
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 100);

    const symbols = sorted.map((s) => s.symbol);

    console.log(`[TopSymbols] Generated TOP100 symbols (${symbols.length})`);
    return symbols;
  } catch (err) {
    console.error("[TopSymbols] Fetch error:", err.message);
    return [];
  }
}

module.exports = { fetchTop100Symbols };
