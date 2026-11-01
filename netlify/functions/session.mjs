// netlify/functions/session.mjs
// Mengelola key pribadi OPSIONAL: simpan (set cookie), cek, dan hapus (logout).
// Aplikasi tetap berfungsi tanpa key pribadi (memakai key server / Netlify AI Gateway).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const COOKIE_NAME = 'uvia_session';
const COOKIE_MAX_AGE = 28800; // 8 jam
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const KEY_PATTERN = /^AIza[\w-]{30,}$/;

// ── Secret untuk enkripsi cookie ───────────────────────────
// Set SESSION_SECRET di Netlify (Site settings → Environment variables).
// Tanpa itu, secret diturunkan dari key server lain; tanpa keduanya dipakai nilai
// bawaan (kurang aman, hanya agar fitur tetap jalan).
function sessionSecret() {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.NETLIFY_AI_GATEWAY_KEY ||
    process.env.UVIA_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (!secret) {
    console.warn('[Session] SESSION_SECRET belum diset — memakai secret bawaan. Segera set di Netlify.');
    return 'uvia-default-secret-ganti-ini';
  }
  return secret;
}

function cipherKey() {
  return createHash('sha256').update(sessionSecret()).digest(); // 32 byte untuk AES-256
}

// ── Enkripsi AES-256-GCM (terautentikasi) ──────────────────
function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function decrypt(encoded) {
  try {
    const buf = Buffer.from(encoded, 'base64url');
    if (buf.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null; // cookie rusak / secret berubah / dimanipulasi
  }
}

// ── Parse cookie header ────────────────────────────────────
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=');
  });
  return cookies;
}

// ── Key pribadi dari cookie ────────────────────────────────
export function getKeyFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!token) return null;
  const key = decrypt(token);
  return key && KEY_PATTERN.test(key) ? key : null;
}

// ── Key publik dari environment (UVIA_API_KEY → GEMINI_API_KEY) ──
// Hanya key Google asli (AIza...) yang dipakai; jika tidak ada, analyze memakai Netlify AI Gateway.
export function getPublicKey() {
  return [process.env.UVIA_API_KEY, process.env.GEMINI_API_KEY]
    .find(k => k && k.startsWith('AIza')) || null;
}

// ── Key untuk agent tertentu ───────────────────────────────
// Prioritas: key pribadi pengguna → UVIA_KEY_<AGENT> → key publik server.
// Key pribadi selalu menang, supaya pengguna bisa lolos dari kuota publik yang habis.
export function getAgentKey(agentName, cookieHeader) {
  const personal = getKeyFromCookie(cookieHeader);
  if (personal) return personal;

  const envKey = process.env[`UVIA_KEY_${agentName.toUpperCase()}`];
  if (envKey && envKey.startsWith('AIza')) return envKey;

  return getPublicKey();
}

// ── Cek key ke Google sebelum disimpan ─────────────────────
// Mengembalikan pesan error bila key jelas ditolak; null bila OK atau tidak bisa dipastikan.
async function checkKeyWithGoogle(apiKey) {
  try {
    const res = await fetch(`${GOOGLE_BASE}/v1beta/models?pageSize=1`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return 'API key ditolak oleh Google (tidak valid atau tidak punya akses).';
    }
  } catch {
    // Jaringan lambat/terputus: jangan blokir penyimpanan
  }
  return null;
}

// ── Handler utama (cek / simpan / hapus key pribadi) ───────
// Hanya dipakai dari origin yang sama, jadi tidak ada header CORS.
export default async (req) => {
  const reply = (status, body, extra = {}) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });

  // GET /session → apakah pengguna punya key pribadi aktif?
  if (req.method === 'GET') {
    return reply(200, { active: !!getKeyFromCookie(req.headers.get('cookie')) });
  }

  // POST /session → simpan key pribadi ke cookie terenkripsi
  if (req.method === 'POST') {
    try {
      const { apiKey: raw } = await req.json().catch(() => ({}));
      const apiKey = typeof raw === 'string' ? raw.trim() : '';

      if (!KEY_PATTERN.test(apiKey)) {
        return reply(400, { error: 'API key Gemini tidak valid. Harus dimulai dengan AIza...' });
      }

      const rejected = await checkKeyWithGoogle(apiKey);
      if (rejected) return reply(400, { error: rejected });

      const cookie = [
        `${COOKIE_NAME}=${encrypt(apiKey)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${COOKIE_MAX_AGE}`,
        'Secure',
      ].join('; ');

      return reply(200, { ok: true, message: 'Key pribadi tersimpan.' }, { 'Set-Cookie': cookie });
    } catch (err) {
      return reply(500, { error: 'Gagal menyimpan key: ' + err.message });
    }
  }

  // DELETE /session → hapus key pribadi, kembali ke key publik
  if (req.method === 'DELETE') {
    const clearCookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
    return reply(200, { ok: true, message: 'Key pribadi dihapus.' }, { 'Set-Cookie': clearCookie });
  }

  return reply(405, { error: 'Method not allowed' });
};
