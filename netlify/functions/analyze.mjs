// netlify/functions/analyze.mjs
// UVIA v2.0 — 8-agent image analysis using Gemini.
// Phase 1: 7 vision agents run in parallel (A1, A2, A3, A4, A5, A7, A8)
// Phase 2: Agent 6 (Synthesis) merges their results + cross-reference + action plan.

import { getAgentKey } from './session.mjs';

const MODEL = process.env.UVIA_MODEL || 'gemini-3-flash-preview';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const MAX_IMAGES = 3;

// ── Agent definitions ──────────────────────────────────────
const SCORE_NOTE = 'All scores are numbers between 0.0 and 1.0. Write verdicts briefly (max 8 words) in Indonesian.';

const AGENTS = {
  origin: {
    dims: 'D1',
    prompt: `You are Agent 1 (Origin). Determine the origin of the image: real camera photo, digital illustration, 3D render, AI-generated, or edited composite.
Return JSON: {"D1":{"score":<0-1, 1 = very likely an original/authentic capture>,"verdict":"...","origin_type":"photo|illustration|3d_render|ai_generated|composite|screenshot","evidence":["..."]}}`,
  },
  human_ai: {
    dims: 'D2+D3',
    prompt: `You are Agent 2 (Human+AI). D2: how much human craft/authorship is involved. D3: probability that AI generation or AI editing was used.
Return JSON: {"D2":{"score":<0-1, 1 = fully human-made>,"verdict":"...","evidence":["..."]},"D3":{"score":<0-1, 1 = certainly AI>,"verdict":"...","indicators":["..."]}}`,
  },
  forensic: {
    dims: 'D4',
    prompt: `You are Agent 3 (Forensic). Look for manipulation: lighting/shadow inconsistencies, cloning, splicing, compression artifacts, warped edges, perspective errors.
Return JSON: {"D4":{"score":<0-1, 1 = strong signs of manipulation>,"verdict":"...","anomalies":["..."]}}`,
  },
  safety_ip: {
    dims: 'D5+D8',
    prompt: `You are Agent 4 (Safety+IP). D5: content safety (violence, sexual content, hate, minors, dangerous content) and privacy (faces, ID documents, license plates, addresses). D8: intellectual property risk (logos, brands, characters, artwork, watermarks, celebrities).
Return JSON: {"D5":{"status":"CLEAN|LOW_RISK|HIGH_RISK|BLOCKED","soft_flags":["..."],"privacy_flags":["..."],"verdict":"..."},"D8":{"score":<0-1, 1 = high IP risk>,"verdict":"...","elements":["..."]}}`,
  },
  value: {
    dims: 'D6+D7',
    prompt: `You are Agent 5 (Value). D6: monetization potential (stock, ads, merchandise) and whether an AI/edit disclosure is required. D7: creative and aesthetic quality (composition, originality, technique).
Return JSON: {"D6":{"score":<0-1, 1 = very high commercial value>,"verdict":"...","disclosure_needed":<true|false>},"D7":{"score":<0-1, 1 = excellent quality>,"verdict":"...","strengths":["..."],"weaknesses":["..."]}}`,
  },
  synthid: {
    dims: 'D10',
    prompt: `You are Agent 7 (SynthID). Estimate whether the image could carry an invisible AI watermark (Google SynthID, C2PA, etc.) based on visual characteristics typical of Imagen/Gemini/DALL-E/Midjourney/Firefly. You cannot read the watermark directly; give an estimate.
Return JSON: {"D10":{"score":<0-1, 1 = very likely watermarked by an AI generator>,"verdict":"...","synthid_possible":<true|false>,"likely_generator":"... or null"}}`,
  },
  uncanny: {
    dims: 'D11',
    prompt: `You are Agent 8 (Uncanny). Evaluate the "uncanny valley" / AI aura: skin that is too smooth, odd hands/fingers, unnatural eyes, garbled text, too-perfect symmetry, dreamy lighting.
Return JSON: {"D11":{"score":<0-1, 1 = very strong AI aura>,"verdict":"...","signals":["..."]}}`,
  },
};

const SYNTHESIS_PROMPT = `You are Agent 6 (Synthesis). You receive JSON outputs from 7 other agents analyzing the same image. Your tasks:
1. D9: classify the most suitable use case.
2. Build a risk matrix for D1–D11 with colors: green (safe), yellow (caution), red (risky), black (blocking/fatal).
   Note: high D1/D2/D6/D7 scores are good; high D3/D4/D8/D10/D11 scores are risky.
3. Cross-reference: find contradictions between agents (e.g. D1 says authentic but D3 says AI).
4. Prioritized action plan.
5. A forensic narrative of 2–4 short paragraphs in Indonesian.
Write all text in Indonesian.
Return JSON:
{"content_class":"...","D9":{"primary":"...","secondary":["..."]},
"risk_matrix":{"D1":"green|yellow|red|black","D2":"...","D3":"...","D4":"...","D5":"...","D6":"...","D7":"...","D8":"...","D9":"...","D10":"...","D11":"..."},
"cross_reference":{"conflicts":["..."]},
"action_plan":{"critical":["..."],"priority":["..."],"optional":["..."]},
"narrative":"..."}`;

// ── Gemini call ────────────────────────────────────────────
class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Personal/env Google key → direct to Google; otherwise → Netlify AI Gateway
function resolveEndpoint(agentName, cookieHeader) {
  const key = getAgentKey(agentName, cookieHeader);
  if (key) return { base: GOOGLE_BASE, key };
  const gwKey = process.env.NETLIFY_AI_GATEWAY_KEY;
  const gwUrl = process.env.NETLIFY_AI_GATEWAY_URL;
  if (gwKey && gwUrl) return { base: gwUrl.replace(/\/$/, ''), key: gwKey };
  return null;
}

async function callGemini(endpoint, parts) {
  const res = await fetch(`${endpoint.base}/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': endpoint.key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || `Gemini HTTP ${res.status}`;
    // Google returns 400 for an invalid API key; treat it as an auth error
    const status = res.status === 400 && /API key/i.test(message) ? 401 : res.status;
    throw new GeminiError(message, status);
  }

  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new GeminiError('Gemini tidak mengembalikan output (mungkin diblokir filter keamanan)', 502);
  return parseJson(text);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new GeminiError('Output agent bukan JSON yang valid', 502);
  }
}

// ── Analyze one image ──────────────────────────────────────
async function analyzeImage(image, config, cookieHeader) {
  const context = `Analysis context — Use case: ${config.useCase || 'Umum'}; Target platform: ${config.platform || 'Umum'}. ${SCORE_NOTE} Reply with JSON only.`;
  const imagePart = { inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.base64 } };

  // Phase 1: vision agents in parallel
  const names = Object.keys(AGENTS);
  const settled = await Promise.allSettled(
    names.map(async name => {
      const endpoint = resolveEndpoint(name, cookieHeader);
      if (!endpoint) throw new GeminiError('API key tidak tersedia', 401);
      return callGemini(endpoint, [{ text: `${AGENTS[name].prompt}\n\n${context}` }, imagePart]);
    })
  );

  // Auth/quota errors apply to the whole request
  const fatal = settled.find(r => r.status === 'rejected' && [401, 403, 429].includes(r.reason?.status));
  if (fatal) throw fatal.reason;

  const merged = {};
  const agentErrors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') Object.assign(merged, r.value);
    else agentErrors.push(`${names[i]}: ${r.reason?.message || 'gagal'}`);
  });
  if (agentErrors.length === names.length) {
    throw new GeminiError(agentErrors[0], 502);
  }

  // Phase 2: synthesis (text only)
  try {
    const synthesis = await callGemini(resolveEndpoint('synthesis', cookieHeader), [{
      text: `${SYNTHESIS_PROMPT}\n\n${context}\n\nAgent outputs:\n${JSON.stringify(merged)}` +
        (agentErrors.length ? `\n\nFailed agents: ${agentErrors.join('; ')}` : ''),
    }]);
    Object.assign(merged, synthesis);
  } catch (err) {
    if ([401, 403, 429].includes(err.status)) throw err;
    merged.narrative = `Agent 6 (Synthesis) gagal: ${err.message}`;
  }

  if (agentErrors.length) {
    merged.cross_reference = merged.cross_reference || {};
    merged.cross_reference.conflicts = [
      ...(merged.cross_reference.conflicts || []),
      ...agentErrors.map(e => `Agent gagal — ${e}`),
    ];
  }

  return merged;
}

// ── Handler ────────────────────────────────────────────────
const reply = (status, body) => Response.json(body, { status });

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Request body tidak valid' });
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!images.length || images.some(img => !img?.base64)) {
    return reply(400, { error: 'Tidak ada gambar untuk dianalisis' });
  }

  const cookieHeader = req.headers.get('cookie');
  if (!resolveEndpoint('origin', cookieHeader)) {
    return reply(401, { error: 'API key tidak tersedia. Masukkan Gemini API key Anda.' });
  }

  const config = body.config || {};
  const settled = await Promise.allSettled(images.map(img => analyzeImage(img, config, cookieHeader)));

  const fatal = settled.find(r => r.status === 'rejected' && [401, 403, 429].includes(r.reason?.status));
  if (fatal) {
    const status = fatal.reason.status;
    const msg = status === 429
      ? 'Kuota Gemini habis. Masukkan API key Anda sendiri untuk melanjutkan.'
      : 'API key Gemini ditolak (tidak valid atau tidak punya akses). Masukkan API key lain.';
    console.error('[Analyze] Gemini error:', fatal.reason.message);
    return reply(status === 429 ? 429 : 401, { error: msg });
  }

  const results = settled.map((r, i) => {
    const file = images[i].name || `image-${i + 1}`;
    if (r.status === 'fulfilled') return { file, parsed: r.value };
    console.error(`[Analyze] ${file}:`, r.reason?.message);
    return { file, error: r.reason?.message || 'Analisis gagal' };
  });

  return reply(200, { results, model: MODEL });
};
