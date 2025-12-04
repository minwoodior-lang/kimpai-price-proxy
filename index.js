const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 캐시 (2초 TTL)
const CACHE_TTL = 2000;
const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.ts < CACHE_TTL) {
    return item.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// 1) 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'proxy-ok', timestamp: new Date().toISOString() });
});

// 2) Binance 프록시 - 전체 리스트 호출 후 symbol 필터링
app.get('/binance/api/v3/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_spot_all';

    let data = getCached(cacheKey);

    if (!data) {
      const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      data = response.data;
      setCache(cacheKey, data);
    }

    if (symbol) {
      const filtered = data.find(x => x.symbol === symbol);
      return res.json(filtered || { symbol, price: '0' });
    }
    return res.json(data);
  } catch (error) {
    console.error('Binance proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Binance proxy failed' });
  }
});

// Binance Futures 프록시
app.get('/binance/fapi/v1/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_futures_all';

    let data = getCached(cacheKey);

    if (!data) {
      const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price', {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      data = response.data;
      setCache(cacheKey, data);
    }

    if (symbol) {
      const filtered = data.find(x => x.symbol === symbol);
      return res.json(filtered || { symbol, price: '0' });
    }
    return res.json(data);
  } catch (error) {
    console.error('Binance Futures proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Binance Futures proxy failed' });
  }
});

// 3) Bybit 프록시 - category만 외부 API에 전달, symbol은 프록시에서 필터링
app.get('/bybit/v5/market/tickers', async (req, res) => {
  try {
    const { category = 'spot', symbol } = req.query;
    const cacheKey = `bybit_${category}_all`;

    let data = getCached(cacheKey);

    if (!data) {
      // 외부 API에는 symbol 없이 category만 전달
      const response = await axios.get('https://api.bybit.com/v5/market/tickers', {
        params: { category },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      data = response.data;
      setCache(cacheKey, data);
    }

    if (symbol && data.result?.list) {
      const filtered = data.result.list.filter(x => x.symbol === symbol);
      return res.json({
        ...data,
        result: {
          ...data.result,
          list: filtered
        }
      });
    }

    return res.json(data);
  } catch (error) {
    console.error('Bybit proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Bybit proxy failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KimpAI Proxy Server running on port ${PORT}`);
});
