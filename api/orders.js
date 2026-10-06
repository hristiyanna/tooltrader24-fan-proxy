/**
 * ToolTrader24 Landing Order Bridge — Vercel proxy
 * Developed by Web R Solution — https://www.webrsolution.com/
 */
const crypto = require('crypto');

function allowedOrigin(origin) {
  if (!origin) return true;

  const explicit = String(process.env.TOOLTRADER24_ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  if (explicit.length) return explicit.includes(origin);

  // Convenient default for the current multi-account Vercel workflow.
  // For tighter security, set TOOLTRADER24_ALLOWED_ORIGINS explicitly.
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

  // Honeypot: landings should keep this hidden field empty.
  if (body.website) {
    return res.status(200).json({ success: true, accepted: true });
  }

  if (!body.terms_accepted) {
    return res.status(422).json({ success: false, error: 'Terms must be accepted' });
  }

  const productId = Number.parseInt(body.product_id, 10);
  const quantity = Number.parseInt(body.quantity || 1, 10);
  if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    return res.status(422).json({ success: false, error: 'Invalid product or quantity' });
  }

  const payload = {
    request_id: text(body.request_id, 64) || crypto.randomUUID(),
    product_id: productId,
    quantity,
    firstname: text(body.firstname, 32),
    lastname: text(body.lastname, 32),
    email: text(body.email, 96),
    telephone: text(body.telephone, 32),
    company: text(body.company, 80),
    delivery_mode: text(body.delivery_mode, 20),
    office: body.office && typeof body.office === 'object' ? {
      id: text(body.office.id, 64),
      code: text(body.office.code, 64),
      name: text(body.office.name, 160),
      address: text(body.office.address, 180),
      city: text(body.office.city, 80),
      postcode: text(body.office.postcode, 20),
      county: text(body.office.county, 80),
      is_machine: Boolean(body.office.is_machine)
    } : {},
    address: body.address && typeof body.address === 'object' ? {
      address_1: text(body.address.address_1, 180),
      city: text(body.address.city, 80),
      postcode: text(body.address.postcode, 20),
      county: text(body.address.county, 80)
    } : {},
    comment: text(body.comment, 500),
    source_url: text(body.source_url || req.headers.referer || '', 300),
    terms_accepted: true,
    client_ip: text((req.headers['x-forwarded-for'] || '').split(',')[0], 64),
    user_agent: text(req.headers['user-agent'], 255),
    accept_language: text(req.headers['accept-language'], 128)
  };

  // Never trust prices/totals supplied by the browser. OpenCart calculates them server-side.
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

  const endpoint = 'https://www.tooltrader24.com/index.php?route=extension/module/landing_order/create';

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
    return res.status(502).json({ success: false, error: 'OpenCart order endpoint unavailable' });
  }
};
