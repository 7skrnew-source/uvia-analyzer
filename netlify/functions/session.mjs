// netlify/functions/session.mjs
// Mengelola sesi: login (set cookie) dan logout (hapus cookie)
// Mendukung multi-key: bisa set API key berbeda per agent via environment variable,
// fallback ke key dari session jika tidak ada.

const COOKIE_NAME = 'uvia_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'uvia-default-secret-ganti-ini';

// ── Enkripsi sederhana (XOR + base64) ──────────────────────
function encrypt(text, secret) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ secret.charCodeAt(i % secret.length));
  }
  return Buffer.from(result, 'binary').toString('base64url');
}

function decrypt(encoded, secret) {
  try {
    const text = Buffer.from(encoded, 'base64url').toString('binary');
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ secret.charCodeAt(i % secret.length));
    }
    return result;
  } catch {
    return null;
  }
}

// ── Parse cookie header ────────────────────────────────────
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    cookies[k.trim()] = v.join('=');
  });
  return cookies;
}

// ── Ambil API key dari cookie (key utama) ──────────────────
export function getKeyFromCookie(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return decrypt(token, SESSION_SECRET);
}

// ── Ambil API key untuk agent tertentu ─────────────────────
// Prioritas: environment variable UVIA_KEY_<AGENT> → cookie
export function getAgentKey(agentName, cookieHeader) {
  const envVar = `UVIA_KEY_${agentName.toUpperCase()}`;
  const envKey = process.env[envVar];
  if (envKey && envKey.startsWith('AIza')) {
    console.log(`[Session] Menggunakan key agent ${agentName} dari env ${envVar}`);
    return envKey;
  }
  const cookieKey = getKeyFromCookie(cookieHeader);
  if (cookieKey && cookieKey.startsWith('AIza')) return cookieKey;
  return getPublicKey();
}

// ── Key publik dari environment (UVIA_API_KEY → GEMINI_API_KEY) ──
// Hanya key Google asli (AIza...) yang dipakai; jika tidak ada, analyze memakai Netlify AI Gateway.
export function getPublicKey() {
  return [process.env.UVIA_API_KEY, process.env.GEMINI_API_KEY]
    .find(k => k && k.startsWith('AIza')) || null;
}

// ── Handler utama (cek sesi / login / logout) ──────────────
export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
  const reply = (status, body, extra = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } });

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  // GET /session → Cek apakah user punya key pribadi di cookie
  if (req.method === 'GET') {
    const key = getKeyFromCookie(req.headers.get('cookie'));
    return reply(200, { active: !!(key && key.startsWith('AIza')) });
  }

  // POST /session → Login: simpan API key ke cookie
  if (req.method === 'POST') {
    try {
      const { apiKey } = await req.json().catch(() => ({}));

      if (!apiKey || !apiKey.startsWith('AIza')) {
        return reply(400, { error: 'API key Gemini tidak valid. Harus dimulai dengan AIza...' });
      }

      const encrypted = encrypt(apiKey, SESSION_SECRET);

      const cookie = [
        `${COOKIE_NAME}=${encrypted}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=28800',
        'Secure',
      ].join('; ');

      return reply(200, { ok: true, message: 'Sesi berhasil dibuat. Siap menganalisis.' }, { 'Set-Cookie': cookie });
    } catch (err) {
      return reply(500, { error: 'Gagal membuat sesi: ' + err.message });
    }
  }

  // DELETE /session → Logout: hapus cookie
  if (req.method === 'DELETE') {
    const clearCookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
    return reply(200, { ok: true, message: 'Sesi dihapus. Sampai jumpa!' }, { 'Set-Cookie': clearCookie });
  }

  return reply(405, { error: 'Method not allowed' });
};
