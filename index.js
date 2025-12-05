const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRICE_CACHE_TTL = 2000;
const STATS_CACHE_TTL = 5000; // Increased from 30s to 5s for better cache efficiency
const STALE_CACHE_TTL = 60000; // Keep stale cache for 1 minute for fallback
const cache = new Map();
const rateLimitTracker = new Map();

function getCached(key, ttl = PRICE_CACHE_TTL, allowStale = false) {
  const item = cache.get(key);
  if (!item) return null;
  
  const age = Date.now() - item.ts;
  
  if (age < ttl) {
    return { data: item.data, isStale: false };
  }
  
  if (allowStale && age < STALE_CACHE_TTL) {
    return { data: item.data, isStale: true };
  }
  
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function recordRateLimit(endpoint) {
  const now = Date.now();
  if (!rateLimitTracker.has(endpoint)) {
    rateLimitTracker.set(endpoint, []);
  }
  const times = rateLimitTracker.get(endpoint);
  times.push(now);
  // Keep only last 60 seconds of requests
  rateLimitTracker.set(endpoint, times.filter(t => now - t < 60000));
}

app.get('/', (req, res) => {
  res.json({ status: 'proxy-ok', timestamp: new Date().toISOString() });
});

app.get('/healthz', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: 'proxy-24hr-v1-with-5s-cache-stale-fallback',
    timestamp: new Date().toISOString(),
    cacheStatus: {
      priceCacheTTL: PRICE_CACHE_TTL,
      statsCacheTTL: STATS_CACHE_TTL,
      staleCacheTTL: STALE_CACHE_TTL
    }
  });
});

app.get('/binance/api/v3/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_spot_all';
    const endpoint = '/binance/api/v3/ticker/price';
    
    console.log(`[Binance Spot Price] Request: symbol=${symbol || 'ALL'}`);

    let cached = getCached(cacheKey, PRICE_CACHE_TTL, true);
    let data = cached?.data;

    if (!data) {
      try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        data = response.data;
        setCache(cacheKey, data);
        console.log(`[Binance Spot Price] Fresh data fetched: ${data.length} items`);
      } catch (err) {
        if (err.response?.status === 429) {
          recordRateLimit(endpoint);
          console.error(`[Binance Spot Price] Rate limited (429). Requests in last 60s: ${rateLimitTracker.get(endpoint)?.length || 0}`);
          
          // Try to use stale cache
          cached = getCached(cacheKey, STALE_CACHE_TTL, true);
          if (cached?.data) {
            console.log('[Binance Spot Price] Using stale cache due to rate limit');
            data = cached.data;
          } else {
            return res.status(503).json({ 
              error: 'Rate limited', 
              code: 'BINANCE_RATE_LIMITED',
              retryAfter: 5
            });
          }
        } else {
          throw err;
        }
      }
    }

    if (symbol) {
      const filtered = data.find(x => x.symbol === symbol);
      return res.json(filtered || { symbol, price: '0' });
    }
    return res.json(data);
  } catch (error) {
    console.error('Binance spot proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Binance proxy failed' });
  }
});

app.get('/binance/fapi/v1/ticker/price', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_futures_all';
    const endpoint = '/binance/fapi/v1/ticker/price';
    
    console.log(`[Binance Futures Price] Request: symbol=${symbol || 'ALL'}`);

    let cached = getCached(cacheKey, PRICE_CACHE_TTL, true);
    let data = cached?.data;

    if (!data) {
      try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price', {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        data = response.data;
        setCache(cacheKey, data);
        console.log(`[Binance Futures Price] Fresh data fetched: ${data.length} items`);
      } catch (err) {
        if (err.response?.status === 429) {
          recordRateLimit(endpoint);
          console.error(`[Binance Futures Price] Rate limited (429)`);
          cached = getCached(cacheKey, STALE_CACHE_TTL, true);
          if (cached?.data) {
            console.log('[Binance Futures Price] Using stale cache due to rate limit');
            data = cached.data;
          } else {
            return res.status(503).json({ error: 'Rate limited', code: 'BINANCE_RATE_LIMITED', retryAfter: 5 });
          }
        } else {
          throw err;
        }
      }
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

app.get('/binance/api/v3/ticker/24hr', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_spot_24hr';
    const endpoint = '/binance/api/v3/ticker/24hr';
    
    console.log(`[Binance 24hr] Request: symbol=${symbol || 'ALL'}`);

    let cached = getCached(cacheKey, STATS_CACHE_TTL, true);
    let data = cached?.data;

    if (!data) {
      try {
        console.log(`[Binance 24hr] Fetching fresh data from https://api.binance.com/api/v3/ticker/24hr (no symbol filter)`);
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        data = response.data;
        setCache(cacheKey, data);
        console.log(`[Binance 24hr] Fresh data cached: ${data.length} tickers for ${STATS_CACHE_TTL/1000}s`);
      } catch (err) {
        if (err.response?.status === 429) {
          recordRateLimit(endpoint);
          const recentRequests = rateLimitTracker.get(endpoint)?.length || 0;
          console.error(`[Binance 24hr] Rate limited (429). Requests in last 60s: ${recentRequests}`);
          
          // Try to use stale cache
          cached = getCached(cacheKey, STALE_CACHE_TTL, true);
          if (cached?.data) {
            console.log('[Binance 24hr] Using stale cache due to rate limit (age: ~1 min)');
            data = cached.data;
            // Return stale data with warning header
            res.set('X-Cache-Status', 'stale');
          } else {
            console.error('[Binance 24hr] No cached data available');
            return res.status(503).json({ 
              error: 'Rate limited by Binance',
              code: 'BINANCE_RATE_LIMITED',
              retryAfter: 5,
              message: 'Too many requests to Binance. Please retry in 5 seconds.'
            });
          }
        } else {
          console.error(`[Binance 24hr] Error: ${err.message} (status: ${err.response?.status})`);
          throw err;
        }
      }
    } else {
      console.log(`[Binance 24hr] Using fresh cache (${cached.isStale ? 'stale' : 'valid'})`);
    }

    if (symbol) {
      const filtered = data.find(x => x.symbol === symbol);
      console.log(`[Binance 24hr] Filtered: ${symbol} -> ${filtered ? 'found' : 'not found'}`);
      return res.json(filtered || null);
    }
    console.log(`[Binance 24hr] Returning all ${data.length} tickers`);
    return res.json(data);
  } catch (error) {
    console.error('Binance 24hr proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Binance 24hr proxy failed', details: error.message });
  }
});

app.get('/binance/fapi/v1/ticker/24hr', async (req, res) => {
  try {
    const { symbol } = req.query;
    const cacheKey = 'binance_futures_24hr';
    const endpoint = '/binance/fapi/v1/ticker/24hr';
    
    console.log(`[Binance Futures 24hr] Request: symbol=${symbol || 'ALL'}`);

    let cached = getCached(cacheKey, STATS_CACHE_TTL, true);
    let data = cached?.data;

    if (!data) {
      try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        data = response.data;
        setCache(cacheKey, data);
        console.log(`[Binance Futures 24hr] Fresh data cached: ${data.length} tickers for ${STATS_CACHE_TTL/1000}s`);
      } catch (err) {
        if (err.response?.status === 429) {
          recordRateLimit(endpoint);
          cached = getCached(cacheKey, STALE_CACHE_TTL, true);
          if (cached?.data) {
            console.log('[Binance Futures 24hr] Using stale cache due to rate limit');
            data = cached.data;
            res.set('X-Cache-Status', 'stale');
          } else {
            return res.status(503).json({ error: 'Rate limited', code: 'BINANCE_FUTURES_RATE_LIMITED', retryAfter: 5 });
          }
        } else {
          throw err;
        }
      }
    }

    if (symbol) {
      const filtered = data.find(x => x.symbol === symbol);
      return res.json(filtered || null);
    }
    return res.json(data);
  } catch (error) {
    console.error('Binance Futures 24hr proxy error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Binance Futures 24hr proxy failed' });
  }
});

app.get('/bybit/v5/market/tickers', async (req, res) => {
  try {
    const { category = 'spot', symbol } = req.query;
    const cacheKey = `bybit_${category}_all`;
    
    console.log(`[Bybit Tickers] Request: category=${category}, symbol=${symbol || 'ALL'}`);

    let cached = getCached(cacheKey, PRICE_CACHE_TTL, true);
    let data = cached?.data;

    if (!data) {
      try {
        const response = await axios.get('https://api.bybit.com/v5/market/tickers', {
          params: { category },
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        data = response.data;
        setCache(cacheKey, data);
        console.log(`[Bybit Tickers] Fresh data cached: ${data.result?.list?.length || 0} items`);
      } catch (err) {
        if (err.response?.status === 429) {
          console.error(`[Bybit Tickers] Rate limited (429)`);
          cached = getCached(cacheKey, STALE_CACHE_TTL, true);
          if (cached?.data) {
            console.log('[Bybit Tickers] Using stale cache due to rate limit');
            data = cached.data;
            res.set('X-Cache-Status', 'stale');
          } else {
            return res.status(503).json({ error: 'Rate limited', code: 'BYBIT_RATE_LIMITED', retryAfter: 5 });
          }
        } else {
          throw err;
        }
      }
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
  console.log(`\n========================================`);
  console.log(`✓ KimpAI Proxy Server running on port ${PORT}`);
  console.log(`✓ Price cache TTL: ${PRICE_CACHE_TTL}ms`);
  console.log(`✓ Stats cache TTL: ${STATS_CACHE_TTL}ms (5 sec)`);
  console.log(`✓ Stale cache TTL: ${STALE_CACHE_TTL}ms (1 min fallback)`);
  console.log(`✓ Rate limit tracking: ENABLED`);
  console.log(`✓ 429 Error handling: ENABLED (503 response + stale cache fallback)`);
  console.log(`========================================\n`);
});
