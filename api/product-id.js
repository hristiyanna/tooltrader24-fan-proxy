/**
 * ToolTrader24 Landing Order Bridge — Vercel product-id resolver proxy
 * Developed by Web R Solution — https://www.webrsolution.com/
 *
 * Landing/builder sends only a public product URL (or model fallback).
 * This proxy HMAC-signs the request and asks OpenCart for the real product_id.
 * Do NOT scrape storefront HTML for product_id.
 */
const crypto = require('crypto');

function allowedOrigin(origin) {
  if (!origin) return true;

  const explicit = String(process.env.TOOLTRADER24_ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  if (explicit.length) return explicit.includes(origin);

  return origin === 'https://www.tooltrader24.com' ||
         origin === 'https://tooltrader24.com' ||
         /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
}

function text(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';

  if (!allowedOrigin(origin)) {
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const secret = process.env.OPENCART_ORDER_SECRET;
  if (!secret || secret.length < 32) {
    return res.status(500).json({ success: false, error: 'Order proxy is not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ success: false, error: 'Invalid JSON' });
  }

  const payload = {};
  const url = text(body.url, 500);
  const model = text(body.model, 64);
  if (url) payload.url = url;
  if (model) payload.model = model;

  if (!payload.url && !payload.model) {
    return res.status(422).json({ success: false, error: 'Provide url or model' });
  }

  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

  const endpoint = 'https://www.tooltrader24.com/index.php?route=extension/module/landing_order/resolveProduct';

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-TT24-Timestamp': timestamp,
        'X-TT24-Signature': signature
      },
      body: raw
    });

    const responseText = await upstream.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (_) {
      responseJson = { success: false, error: 'Invalid response from OpenCart' };
    }

    return res.status(upstream.status).json(responseJson);
  } catch (error) {
    return res.status(502).json({ success: false, error: 'OpenCart product resolver unavailable' });
  }
};
