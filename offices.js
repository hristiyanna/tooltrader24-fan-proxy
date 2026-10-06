module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.NEXTCART_FAN_TOKEN;
  if (!token) return res.status(500).json({ error: 'Proxy is not configured' });

  const term = String(req.query.term || '').trim().slice(0, 120);
  const offsetRaw = Number.parseInt(String(req.query.offset || '0'), 10);
  const limitRaw = Number.parseInt(String(req.query.limit || '200'), 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 200);

  if (term.length < 2) return res.status(400).json({ error: 'term must contain at least 2 characters' });

  const base = 'https://api.nextcartmanager.com/api/checkout/v1/offices/' + encodeURIComponent(token) + '/search';
  const url = new URL(base);
  url.searchParams.set('term', term);
  url.searchParams.set('courier', 'fan');
  url.searchParams.set('country', 'RO');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));

  try {
    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(text);
  } catch (error) {
    return res.status(502).json({ error: 'FAN office lookup failed' });
  }
};
