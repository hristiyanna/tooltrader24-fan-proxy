/**
 * ToolTrader24 Product ID Resolver — Vercel function
 *
 * Purpose:
 * Resolve the REAL OpenCart product_id for the MAIN product on a public
 * ToolTrader24 product page.
 *
 * Important:
 * - It does NOT simply take the first product_id found in the HTML.
 * - Related/recommended products can also contain product IDs.
 * - It prefers the product_id closest to the main OpenCart product form
 *   (#product / button-cart), which is the ID used by Add to Cart.
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

function collectProductIdCandidates(html) {
  const source = String(html || '');
  const candidates = [];

  const patterns = [
    /<input\b[^>]*\bname=["']product_id["'][^>]*\bvalue=["'](\d+)["'][^>]*>/gi,
    /<input\b[^>]*\bvalue=["'](\d+)["'][^>]*\bname=["']product_id["'][^>]*>/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const id = Number.parseInt(match[1], 10);
      if (Number.isInteger(id) && id > 0) {
        candidates.push({
          id,
          index: match.index,
          html: match[0]
        });
      }
    }
  }

  // Deduplicate same occurrence / same ID near same place.
  const seen = new Set();
  return candidates.filter(item => {
    const key = `${item.id}:${item.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function markerIndexes(html) {
  const source = String(html || '');
  const indexes = [];

  const markerPatterns = [
    /\bid=["']product["']/gi,
    /\bid=["']button-cart["']/gi,
    /\bname=["']quantity["']/gi
  ];

  for (const pattern of markerPatterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      indexes.push(match.index);
    }
  }

  return indexes;
}

function extractMainProductId(html) {
  const source = String(html || '');
  const candidates = collectProductIdCandidates(source);

  if (!candidates.length) {
    return { productId: null, method: null, candidateCount: 0 };
  }

  const markers = markerIndexes(source);

  // Best case: choose the hidden product_id nearest to the main product form/cart marker.
  if (markers.length) {
    let best = null;

    for (const candidate of candidates) {
      for (const marker of markers) {
        const distance = Math.abs(candidate.index - marker);

        // Strong preference for IDs close to the product form.
        // The main hidden product_id is normally only a short distance away.
        if (!best || distance < best.distance) {
          best = { candidate, marker, distance };
        }
      }
    }

    if (best && best.distance <= 15000) {
      return {
        productId: best.candidate.id,
        method: 'main-product-form',
        candidateCount: candidates.length,
        distance: best.distance
      };
    }
  }

  /*
   * Fallback 1:
   * Search a bounded window around id="product". This avoids IDs in
   * related/recommended product cards elsewhere on the page.
   */
  const mainProductMatch = source.match(/\bid=["']product["']/i);
  if (mainProductMatch && typeof mainProductMatch.index === 'number') {
    const start = Math.max(0, mainProductMatch.index - 3000);
    const end = Math.min(source.length, mainProductMatch.index + 20000);
    const windowHtml = source.slice(start, end);

    const windowCandidates = collectProductIdCandidates(windowHtml);
    if (windowCandidates.length === 1) {
      return {
        productId: windowCandidates[0].id,
        method: 'product-window',
        candidateCount: candidates.length
      };
    }
  }

  /*
   * Fallback 2:
   * Some OpenCart themes expose the main product ID in an Add-to-Cart call.
   * Do NOT use generic product_id= matches from the whole page, because
   * related products can contain those too.
   */
  const cartPatterns = [
    /\bid=["']button-cart["'][\s\S]{0,12000}?product_id[^0-9]{0,20}(\d+)/i,
    /\bcart\.add\(\s*["']?(\d+)["']?/i
  ];

  for (const pattern of cartPatterns) {
    const match = source.match(pattern);
    if (match) {
      const id = Number.parseInt(match[1], 10);
      if (Number.isInteger(id) && id > 0) {
        return {
          productId: id,
          method: 'cart-handler',
          candidateCount: candidates.length
        };
      }
    }
  }

  // Deliberately fail instead of returning a possibly wrong related-product ID.
  return {
    productId: null,
    method: null,
    candidateCount: candidates.length
  };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; ToolTrader24ProductResolver/2.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
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
      ) {
        continue;
      }

      const normalized = url.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch (_) {}
  }

  return links.slice(0, 30);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return send(res, 405, {
      success: false,
      error: 'Method not allowed'
    });
  }

  const rawUrl = String(req.query.url || '').trim();
  const model = String(req.query.model || '').trim().slice(0, 120);

  if (!rawUrl && !model) {
    return send(res, 400, {
      success: false,
      error: 'Provide url or model'
    });
  }

  try {
    /*
     * Preferred mode: public product URL.
     */
    if (rawUrl) {
      let productUrl;

      try {
        productUrl = new URL(rawUrl);
      } catch (_) {
        return send(res, 400, {
          success: false,
          error: 'Invalid url'
        });
      }

      if (
        productUrl.protocol !== 'https:' ||
        !isAllowedHost(productUrl.hostname)
      ) {
        return send(res, 400, {
          success: false,
          error: 'Only public ToolTrader24 product URLs are allowed'
        });
      }

      const html = await fetchHtml(productUrl.toString());
      const result = extractMainProductId(html);

      if (!result.productId) {
        return send(res, 404, {
          success: false,
          error: 'Could not safely identify the main product_id',
          candidates_found: result.candidateCount
        });
      }

      return send(res, 200, {
        success: true,
        product_id: result.productId,
        source: 'url',
        method: result.method
      });
    }

    /*
     * Fallback mode: model/search term.
     * Search the shop, open candidate product pages, then resolve the MAIN
     * product ID from each page using the same safe logic above.
     */
    const searchUrl =
      'https://www.tooltrader24.com/index.php?route=product/search&search=' +
      encodeURIComponent(model);

    const searchHtml = await fetchHtml(searchUrl);
    const candidates = extractCandidateProductLinks(searchHtml);

    for (const candidateUrl of candidates) {
      try {
        const html = await fetchHtml(candidateUrl);

        // Ensure the candidate page actually contains the requested model/term.
        if (!html.toLowerCase().includes(model.toLowerCase())) continue;

        const result = extractMainProductId(html);

        if (result.productId) {
          return send(res, 200, {
            success: true,
            product_id: result.productId,
            source: 'model-search',
            method: result.method,
            product_url: candidateUrl
          });
        }
      } catch (_) {
        // Try the next candidate.
      }
    }

    return send(res, 404, {
      success: false,
      error: 'Could not safely resolve product_id for model'
    });
  } catch (_) {
    return send(res, 502, {
      success: false,
      error: 'Could not resolve product_id'
    });
  }
};
