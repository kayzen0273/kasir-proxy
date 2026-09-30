/**
 * Reverse proxy satu-situs untuk fitur "Script / Bookmarklet" di menu Browser.
 *
 * Cara kerja:
 *  - Semua request ke domain proxy ini diteruskan ke TARGET_URL dengan path yang SAMA
 *    (jadi aplikasi SPA tetap membaca path aslinya).
 *  - Header pemblokir iframe (X-Frame-Options, CSP) dibuang.
 *  - Ke setiap halaman HTML disisipkan "agent" kecil. Agent ini menerima perintah
 *    dari aplikasi induk lewat postMessage, menjalankan JavaScript-nya di halaman,
 *    lalu mengirim hasilnya balik.
 *
 * Env (opsional):
 *  TARGET_URL    default https://app.farmacare.id
 *  REWRITE_TEXT  isi "0" untuk mematikan penggantian alamat asli -> alamat proxy di HTML/JS/JSON/CSS
 */

const TARGET = (process.env.TARGET_URL || 'https://app.farmacare.id').replace(/\/+$/, '');
const TARGET_HOST = new URL(TARGET).host;
const REWRITE = process.env.REWRITE_TEXT !== '0';

// ---------- Agent yang disisipkan ke halaman (ditulis ES5, di-serialize jadi string) ----------
function agent() {
  if (window.__csAgent) return;
  window.__csAgent = 1;
  var P = window.parent;
  if (!P || P === window) return; // hanya aktif kalau dibuka di dalam iframe

  function post(m) {
    m.cs = 1;
    try { P.postMessage(m, '*'); } catch (e) {}
  }
  function ready(first) {
    post({ type: 'ready', first: !!first, href: location.pathname + location.search + location.hash, title: document.title });
  }

  // Terima perintah jalankan-kode dari aplikasi induk (hanya dari window.parent)
  window.addEventListener('message', function (e) {
    if (e.source !== P) return;
    var d = e.data;
    if (!d || d.cs !== 'run') return;
    var out;
    try {
      var r = (0, eval)(d.code);
      out = { ok: true, value: r === undefined ? '' : String(r).slice(0, 300) };
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
    out.type = 'result';
    out.id = d.id;
    post(out);
  });

  // Laporkan perpindahan halaman (termasuk navigasi SPA)
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(function () { ready(false); }, 0);
      return r;
    };
  });
  window.addEventListener('popstate', function () { ready(false); });
  window.addEventListener('hashchange', function () { ready(false); });
  if (document.readyState === 'complete') ready(true);
  else window.addEventListener('load', function () { ready(true); });

  // Cegah link target=_top / _parent menimpa seluruh aplikasi induk
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (a && /^_(top|parent)$/i.test(a.getAttribute('target'))) a.setAttribute('target', '_self');
  }, true);
}
const AGENT = '(' + agent.toString() + ')();';

// ---------- Util ----------
const DROP_REQ = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'origin', 'referer',
  'if-none-match', 'if-modified-since', 'range', 'forwarded', 'x-real-ip', 'upgrade-insecure-requests'
]);
const DROP_RES = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'set-cookie', 'location', 'etag', 'last-modified',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'report-to', 'nel'
]);

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function fixCookie(c) {
  const parts = c.split(';').map(function (s) { return s.trim(); });
  const nameValue = parts.shift();
  const keep = parts.filter(function (p) { return !/^(domain|secure|samesite|partitioned)(=|$)/i.test(p); });
  if (!keep.some(function (p) { return /^path=/i.test(p); })) keep.push('Path=/');
  // Halaman dimuat di iframe lintas-situs, jadi cookie harus SameSite=None; Secure.
  keep.push('Secure', 'SameSite=None', 'Partitioned');
  return [nameValue].concat(keep).join('; ');
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const proxyHost = req.headers.host;
    const target = TARGET + (req.url.startsWith('/') ? req.url : '/' + req.url);

    // --- request ke upstream ---
    const headers = {};
    for (const k of Object.keys(req.headers)) {
      if (DROP_REQ.has(k) || k.startsWith('x-forwarded-') || k.startsWith('x-vercel-') || k.startsWith('sec-fetch-')) continue;
      headers[k] = req.headers[k];
    }
    headers['referer'] = TARGET + '/';
    const method = req.method || 'GET';
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await readBody(req);
      headers['origin'] = TARGET;
      if (!body.length) body = undefined;
    }

    const up = await fetch(target, { method, headers, body, redirect: 'manual' });

    // --- header respons ---
    up.headers.forEach(function (v, k) {
      if (!DROP_RES.has(k)) res.setHeader(k, v);
    });
    const cookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
    if (cookies.length) res.setHeader('Set-Cookie', cookies.map(fixCookie));
    const loc = up.headers.get('location');
    if (loc) {
      res.setHeader('Location', loc.startsWith(TARGET) ? loc.slice(TARGET.length) || '/' : loc);
    }
    res.setHeader('Cache-Control', 'no-store');

    // --- body ---
    let buf = Buffer.from(await up.arrayBuffer());
    const ct = up.headers.get('content-type') || '';
    const isHtml = /text\/html/i.test(ct);
    const isText = /(text\/|javascript|json|xml|css)/i.test(ct);
    const charsetOk = !/charset=/i.test(ct) || /charset=["']?utf-?8/i.test(ct);

    if (REWRITE && isText && charsetOk && buf.length) {
      let t = buf.toString('utf8');
      const re = new RegExp('(https?:)?((?:\\\\)?/(?:\\\\)?/)' + esc(TARGET_HOST), 'g');
      t = t.replace(re, function (m, p, slashes) {
        return (p ? proto + ':' : '') + slashes + proxyHost;
      });
      if (isHtml) {
        t = t
          .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')
          .replace(/\sintegrity=("[^"]*"|'[^']*')/gi, '');
        const tag = '<script>' + AGENT + '</script>';
        if (/<head[^>]*>/i.test(t)) t = t.replace(/<head[^>]*>/i, function (m) { return m + tag; });
        else t = tag + t;
      }
      buf = Buffer.from(t, 'utf8');
      if (isHtml) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }

    res.statusCode = up.status;
    res.end(method === 'HEAD' ? undefined : buf);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Proxy gagal menghubungi situs tujuan: ' + (err && err.message ? err.message : err));
  }
};
