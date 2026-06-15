// shop.js — proxy para Monambiente
// =========================================================================
// Dos modos:
//   ?q=sillon&limit=6   -> búsqueda (MercadoLibre + Arredo)  [como antes]
//   ?url=<link>         -> UN producto: nombre, dimensiones y foto (base64)
//                          para reemplazar/texturizar la pieza seleccionada.
//
// Deploy (Netlify):  netlify/functions/shop.js  -> /.netlify/functions/shop
// Opcional: env var MELI_TOKEN (developers.mercadolibre.com.ar) para más límite.
// Respetá los Términos de Servicio de cada sitio y un uso razonable.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};
const mlHeaders = () => (process.env.MELI_TOKEN ? { Authorization: 'Bearer ' + process.env.MELI_TOKEN } : {});
const UA = 'Mozilla/5.0 (compatible; MonambienteBot/1.0; +https://monambiente.app)';
function mlIdFromText(t) { const m = (t || '').match(/(ML[A-Z])-?(\d{6,})/i); return m ? (m[1] + m[2]).toUpperCase() : null; }
async function mlProduct(id) {
  for (const ep of ['https://api.mercadolibre.com/items/' + id, 'https://api.mercadolibre.com/products/' + id]) {
    try {
      const r = await fetch(ep, { headers: mlHeaders() });
      if (!r.ok) continue;
      const it = await r.json();
      const name = it.title || it.name; if (!name) continue;
      const pics = (it.pictures || []).map(p => p.secure_url || p.url).filter(Boolean);
      const dims = dimsFromAttributes(it.attributes);
      const imageData = await fetchImageData(pics[0]);
      return { site: 'MercadoLibre', name, price: it.price || null, dims, images: pics.slice(0, 6), imageData };
    } catch (e) {}
  }
  return null;
}

// ---- helpers ----
function parseLen(s) { // devuelve cm
  if (s == null) return null;
  const m = String(s).toLowerCase().replace(',', '.').match(/([\d.]+)\s*(mm|cm|m)?/);
  if (!m) return null;
  let v = parseFloat(m[1]); if (!isFinite(v)) return null;
  const u = m[2] || 'cm';
  if (u === 'm') v *= 100; else if (u === 'mm') v /= 10;
  if (v <= 0 || v > 1200) return null; // descartar valores absurdos
  return Math.round(v);
}
function dimsFromAttributes(attrs) {
  const out = { w: null, d: null, h: null };
  for (const a of attrs || []) {
    const id = (a.id || '').toUpperCase();
    const nm = (a.name || '').toLowerCase();
    if (id.startsWith('PACKAGE') || nm.includes('embalaje') || nm.includes('paquete')) continue;
    const val = a.value_name || (a.values && a.values[0] && a.values[0].name);
    const len = parseLen(val);
    if (len == null) continue;
    if ((id === 'WIDTH' || nm.includes('ancho')) && !out.w) out.w = len;
    else if ((id === 'HEIGHT' || nm.includes('alto') || nm.includes('altura')) && !out.h) out.h = len;
    else if ((id === 'DEPTH' || id === 'LENGTH' || nm.includes('profundidad') || nm.includes('largo') || nm.includes('fondo')) && !out.d) out.d = len;
  }
  return (out.w || out.d || out.h) ? out : null;
}
async function fetchImageData(url) {
  try {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null; // cap 4MB
    return 'data:' + ct + ';base64,' + buf.toString('base64');
  } catch (e) { return null; }
}
function og(html, prop) {
  if (!html) return null;
  let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']og:' + prop + '["\'][^>]+content=["\']([^"\']+)', 'i'));
  if (m) return m[1];
  m = html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:' + prop + '["\']', 'i'));
  return m ? m[1] : null;
}
function dimsFromHtml(html) {
  if (!html) return null;
  const out = { w: null, d: null, h: null };
  const byId = (k) => { const m = html.match(new RegExp('"id":"' + k + '"[^}]*?"value_name":"([^"]+)"', 'i')); return m ? parseLen(m[1]) : null; };
  const byName = (re) => { const m = html.match(new RegExp('"name":"(?:' + re + ')"[^}]*?"value_name":"([^"]+)"', 'i')); return m ? parseLen(m[1]) : null; };
  out.w = byId('WIDTH') || byName('Ancho');
  out.h = byId('HEIGHT') || byName('Alto|Altura');
  out.d = byId('DEPTH') || byId('LENGTH') || byName('Profundidad|Largo|Fondo');
  return (out.w || out.d || out.h) ? out : null;
}

// ---- producto único por link ----
async function productFromUrl(url) {
  const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();

  // ---- MercadoLibre ----
  if (/mercadolib|mercadolivre/i.test(url) || /(ML[A-Z])-?\d{6,}/i.test(url) || host.includes('mercadoli')) {
    let pageHtml = null, slug = '';
    try { slug = decodeURIComponent((new URL(url).pathname.split('/').filter(Boolean)[0]) || '').replace(/-/g, ' ').trim(); } catch (e) {}
    let id = mlIdFromText(url);
    if (!id) { // sin id en la URL: abro la página para encontrarlo
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
        if (r.ok) { pageHtml = await r.text();
          const canon = (pageHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) || [])[1] || og(pageHtml, 'url');
          id = mlIdFromText(canon || '') || mlIdFromText(pageHtml);
        }
      } catch (e) {}
    }
    let prod = id ? await mlProduct(id) : null;
    if (prod && prod.imageData) return prod; // mejor caso: API con foto
    // la API pública suele venir limitada (sin fotos): voy a la página
    if (!pageHtml) { try { const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' }); if (r.ok) pageHtml = await r.text(); } catch (e) {} }
    let name = (prod && prod.name) || (pageHtml && og(pageHtml, 'title')) || slug || 'Producto';
    let dims = (prod && prod.dims) || dimsFromHtml(pageHtml);
    let ogImg = pageHtml ? (og(pageHtml, 'image:secure_url') || og(pageHtml, 'image')) : null;
    let imageData = (prod && prod.imageData) || await fetchImageData(ogImg);
    // último recurso: buscar por el nombre y usar la primera foto
    if (!imageData && slug) {
      try { const items = await fromMercadoLibre(slug, 1); if (items[0]) { if (!name || name === 'Producto') name = items[0].name; imageData = await fetchImageData(items[0].images && items[0].images[0]); } } catch (e) {}
    }
    if (name || imageData || dims) return { site: 'MercadoLibre', name, price: (prod && prod.price) || null, dims: dims || null, images: ogImg ? [ogImg] : [], imageData };
  }

  // ---- Arredo (VTEX) ----
  if (host.includes('arredo')) {
    try {
      const slug = (new URL(url).pathname.replace(/\/p\/?$/, '').split('/').filter(Boolean).pop()) || '';
      const r = await fetch('https://www.arredo.com.ar/api/catalog_system/pub/products/search/' + encodeURIComponent(slug), { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const arr = await r.json();
        const p = arr && arr[0];
        if (p) {
          const dims = { w: null, d: null, h: null };
          for (const k of Object.keys(p)) {
            const lk = k.toLowerCase(); const v = Array.isArray(p[k]) ? p[k][0] : p[k];
            if (lk.includes('ancho') && !dims.w) dims.w = parseLen(v);
            else if ((lk.includes('alto') || lk.includes('altura')) && !dims.h) dims.h = parseLen(v);
            else if ((lk.includes('profundidad') || lk.includes('fondo') || lk.includes('largo')) && !dims.d) dims.d = parseLen(v);
          }
          const item = (p.items && p.items[0]) || {};
          const pics = (item.images || []).map(im => im.imageUrl).filter(Boolean);
          const imageData = await fetchImageData(pics[0]);
          return { site: 'Arredo', name: p.productName, price: null, dims: (dims.w || dims.d || dims.h) ? dims : null, images: pics.slice(0, 6), imageData };
        }
      }
    } catch (e) {}
  }

  // ---- genérico (Open Graph) ----
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const html = await r.text();
      const name = og(html, 'title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || 'Producto';
      const img = og(html, 'image:secure_url') || og(html, 'image');
      const imageData = await fetchImageData(img);
      return { site: host, name: String(name).trim().slice(0, 80), price: null, dims: dimsFromHtml(html), images: img ? [img] : [], imageData };
    }
  } catch (e) {}

  return null;
}

// ---- búsqueda (igual que antes) ----
async function fromMercadoLibre(q, limit) {
  const url = 'https://api.mercadolibre.com/sites/MLA/search?q=' + encodeURIComponent(q) + '&limit=' + limit;
  const res = await fetch(url, { headers: mlHeaders() });
  if (!res.ok) throw new Error('ML ' + res.status);
  const data = await res.json();
  const results = (data.results || []).slice(0, limit);
  return Promise.all(results.map(async (r) => {
    let pictures = [];
    try { const d = await fetch('https://api.mercadolibre.com/items/' + r.id, { headers: mlHeaders() }); if (d.ok) { const it = await d.json(); pictures = (it.pictures || []).map(p => p.secure_url || p.url); } } catch (e) {}
    if (!pictures.length && r.thumbnail) pictures = [r.thumbnail.replace(/-I\.jpg|-O\.jpg/, '-F.jpg')];
    const inst = r.installments; let installments = '';
    if (inst && inst.quantity) installments = inst.quantity + ' cuotas de $' + Math.round(inst.amount).toLocaleString('es-AR') + (inst.rate === 0 ? ' sin interés' : '');
    let discount = ''; if (r.original_price && r.original_price > r.price) discount = Math.round((1 - r.price / r.original_price) * 100) + '% OFF';
    return { site: 'MercadoLibre', name: r.title, price: r.price, installments, discount, rating: (r.reviews && r.reviews.rating_average) || null, images: pictures.slice(0, 6), link: r.permalink };
  }));
}
async function fromArredo(q, limit) {
  const url = 'https://www.arredo.com.ar/api/catalog_system/pub/products/search/' + encodeURIComponent(q) + '?_from=0&_to=' + (limit - 1);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Arredo ' + res.status);
  const data = await res.json();
  return (data || []).slice(0, limit).map((p) => {
    const item = (p.items && p.items[0]) || {};
    const offer = (item.sellers && item.sellers[0] && item.sellers[0].commertialOffer) || {};
    const images = (item.images || []).map(im => im.imageUrl).slice(0, 6);
    let installments = '';
    if (offer.Installments && offer.Installments.length) { const best = offer.Installments.reduce((a, b) => (b.NumberOfInstallments > a.NumberOfInstallments ? b : a)); installments = best.NumberOfInstallments + ' cuotas de $' + Math.round(best.Value).toLocaleString('es-AR') + (best.InterestRate === 0 ? ' sin interés' : ''); }
    let discount = ''; if (offer.ListPrice && offer.Price && offer.ListPrice > offer.Price) discount = Math.round((1 - offer.Price / offer.ListPrice) * 100) + '% OFF';
    return { site: 'Arredo', name: p.productName, price: offer.Price || null, installments, discount, rating: null, images, link: 'https://www.arredo.com.ar/' + p.linkText + '/p' };
  });
}
async function search(q, limit) {
  const [ml, ar] = await Promise.allSettled([fromMercadoLibre(q, limit), fromArredo(q, limit)]);
  const out = [];
  if (ml.status === 'fulfilled') out.push(...ml.value);
  if (ar.status === 'fulfilled') out.push(...ar.value);
  return out;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  try {
    if (p.url) {
      const item = await productFromUrl(p.url);
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'no pude leer el producto' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ item }) };
    }
    const q = p.q || '';
    if (!q) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'falta q o url' }) };
    const limit = Math.min(parseInt(p.limit || '5', 10), 10);
    const items = await search(q, limit);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ items }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
