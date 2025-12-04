const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// 1) Health check
app.get('/', (req, res) => {
  res.json({
    status: 'proxy-ok',
    timestamp: new Date().toISOString(),
  });
});

// 2) Binance Spot
app.get('/binance/api/v3/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;

    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/price'
    );
    const data = response.data;

    if (symbol) {
      const filtered = data.find((x) => x.symbol === symbol);
      return res.json(filtered || { symbol, price: '0' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Binance spot proxy error:', error.message);
    res.status(500).json({ error: 'Binance spot proxy failed' });
  }
});

// 3) Binance Futures
app.get('/binance/fapi/v1/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;

    const response = await axios.get(
      'https://fapi.binance.com/fapi/v1/ticker/price'
    );
    const data = response.data;

    if (symbol) {
      const filtered = data.find((x) => x.symbol === symbol);
      return res.json(filtered || { symbol, price: '0' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Binance futures proxy error:', error.message);
    res.status(500).json({ error: 'Binance futures proxy failed' });
  }
});

// 4) Bybit Spot
app.get('/bybit/v5/market/tickers', async (req, res) => {
  try {
    const { symbol, category = 'spot' } = req.query;

    // 원본 Bybit API (symbol 없이 전체 리스트 호출)
    const response = await axios.get(
      'https://api.bybit.com/v5/market/tickers',
      {
        params: { category: 'spot' }, // category는 강제 spot
      }
    );

    const data = response.data;

    if (symbol && data.result && Array.isArray(data.result.list)) {
      const filtered = data.result.list.find((x) => x.symbol === symbol);
      return res.json({
        retCode: 0,
        retMsg: 'OK',
        result: {
          category: 'spot',
          list: filtered ? [filtered] : [],
        },
        retExtInfo: {},
        time: Date.now(),
      });
    }

    return res.json(data);
  } catch (error) {
    console.error('Bybit spot proxy error:', error.message);
    res.status(500).json({ error: 'Bybit spot proxy failed' });
  }
});

app.listen(PORT, () => {
  console.log('KimpAI Proxy Server running on port', PORT);
});
