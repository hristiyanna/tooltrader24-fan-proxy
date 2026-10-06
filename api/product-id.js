/**
 * ToolTrader24 Product ID Resolver — Vercel function
 * Resolves a real OpenCart product_id from a public ToolTrader24 product URL
 * or, as a fallback, from a model/search term.
 */

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'tooltrader24.com' || host === 'www.tooltrader24.com';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractProductId(html) {
  const source = String(html || '');
  const patterns = [
    /name=["']product_id["'][^>]*value=["'](\d+)["']/i,
    /value=["'](\d+)["'][^>]*name=["']product_id["']/i,
    /["']product_id["']\s*[:=]\s*["']?(\d+)["']?/i,
    /product_id=(\d+)/i,
    /cart\.add\(\s*["']?(\d+)["']?/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && Number.parseInt(match[1], 10) > 0) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function extractCandidateProductLinks(html) {
  const links = [];
  const seen = new Set();
  const source = String(html || '');
  const re = /href=["']([^"']+)["']/gi;

  let match;
  while ((match = re.exec(source)) !== null) {
    const href = decodeHtml(match[1]);
    try {
      const url = new URL(href, 'https://www.tooltrader24.com/');
      if (!isAllowedHost(url.hostname)) continue;

      const p = url.pathname.toLowerCase();
      const q = url.search.toLowerCase();
      if (
        p.includes('/admin/') ||
        q.includes('route=account/') ||
        q.includes('route=checkout/') ||
        q.includes('route=information/')
      ) continue;

      const normalized = url.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch (_) {}
  }

  return links.slice(0, 30);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; ToolTrader24ProductResolver/1.0)'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return send(res, 405, { success: false, error: 'Method not allowed' });
  }

  const rawUrl = String(req.query.url || '').trim();
  const model = String(req.query.model || '').trim().slice(0, 120);

  if (!rawUrl && !model) {
    return send(res, 400, { success: false, error: 'Provide url or model' });
  }

  try {
    if (rawUrl) {
      let productUrl;
      try {
        productUrl = new URL(rawUrl);
      } catch (_) {
        return send(res, 400, { success: false, error: 'Invalid url' });
      }

      if (productUrl.protocol !== 'https:' || !isAllowedHost(productUrl.hostname)) {
        return send(res, 400, {
          success: false,
          error: 'Only public ToolTrader24 product URLs are allowed'
        });
      }

      const html = await fetchHtml(productUrl.toString());
      const productId = extractProductId(html);

      if (!productId) {
        return send(res, 404, {
          success: false,
          error: 'product_id not found on public product page'
        });
      }

      return send(res, 200, {
        success: true,
        product_id: productId,
        source: 'url'
      });
    }

    const searchUrl =
      'https://www.tooltrader24.com/index.php?route=product/search&search=' +
      encodeURIComponent(model);

    const searchHtml = await fetchHtml(searchUrl);

    const directId = extractProductId(searchHtml);
    if (directId) {
      return send(res, 200, {
        success: true,
        product_id: directId,
        source: 'model-search'
      });
    }

    const candidates = extractCandidateProductLinks(searchHtml);

    for (const candidate of candidates) {
      try {
        const html = await fetchHtml(candidate);
        if (!html.toLowerCase().includes(model.toLowerCase())) continue;

        const productId = extractProductId(html);
        if (productId) {
          return send(res, 200, {
            success: true,
            product_id: productId,
            source: 'model-search',
            product_url: candidate
          });
        }
      } catch (_) {}
    }

    return send(res, 404, {
      success: false,
      error: 'product_id not found for model'
    });
  } catch (_) {
    return send(res, 502, {
      success: false,
      error: 'Could not resolve product_id'
    });
  }
};
