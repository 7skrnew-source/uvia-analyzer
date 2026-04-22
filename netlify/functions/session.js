// netlify/functions/session.js
// Mengelola sesi: login (set cookie) dan logout (hapus cookie)
// API key DIENKRIPSI lalu disimpan di HTTP-only cookie
// Browser TIDAK BISA membaca cookie ini lewat JavaScript

const COOKIE_NAME = 'uvia_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'uvia-default-secret-ganti-ini';

// ── Enkripsi sederhana (XOR + base64) — cukup untuk menyembunyikan key di cookie
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

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    cookies[k.trim()] = v.join('=');
  });
  return cookies;
}

// Ekspor helper untuk dipakai function lain
exports.getKeyFromCookie = function(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return decrypt(token, SESSION_SECRET);
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': event.headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POST /session → Login: simpan API key ke cookie
  if (event.httpMethod === 'POST') {
    try {
      const { apiKey } = JSON.parse(event.body || '{}');

      if (!apiKey || !apiKey.startsWith('AIza')) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'API key Gemini tidak valid. Harus dimulai dengan AIza...' })
        };
      }

      // Enkripsi key lalu simpan di cookie
      const encrypted = encrypt(apiKey, SESSION_SECRET);

      // HTTP-only cookie: JS tidak bisa baca, aman dari XSS
      // SameSite=Strict: tidak dikirim dari website lain (CSRF protection)
      // Max-Age: 8 jam
      const cookie = [
        `${COOKIE_NAME}=${encrypted}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=28800',
        // 'Secure', // aktifkan ini di production HTTPS
      ].join('; ');

      return {
        statusCode: 200,
        headers: { ...headers, 'Set-Cookie': cookie },
        body: JSON.stringify({ ok: true, message: 'Sesi berhasil dibuat. Siap menganalisis.' })
      };

    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Gagal membuat sesi: ' + err.message })
      };
    }
  }

  // DELETE /session → Logout: hapus cookie
  if (event.httpMethod === 'DELETE') {
    const clearCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    return {
      statusCode: 200,
      headers: { ...headers, 'Set-Cookie': clearCookie },
      body: JSON.stringify({ ok: true, message: 'Sesi dihapus. Sampai jumpa!' })
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
