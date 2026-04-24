// netlify/functions/analyze.js
// ═══════════════════════════════════════════════════════════════
// UVIA MULTI-AGENT SYSTEM v2.0
// 8 Agent Spesialis — termasuk SynthID (D10) & Uncanny Valley (D11)
// Multi-key support via env vars, Cross-Reference di Agent 6
// ═══════════════════════════════════════════════════════════════

const { getKeyFromCookie, getAgentKey } = require('./session');

const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// ── Audit safety config ───────────────────────────────────
function auditSafety() {
  const overrides = [];
  for (const s of SAFETY) {
    if (s.threshold === 'BLOCK_NONE') {
      overrides.push(`${s.category}: ${s.threshold}`);
    }
  }
  return {
    is_default: overrides.length <= 1,
    overrides,
    note: overrides.length > 1
      ? `⚠️ NON-DEFAULT SAFETY: ${overrides.length} filter dalam posisi BLOCK_NONE`
      : 'Default safety configuration'
  };
}

// ── Panggil satu agent Gemini dengan gambar + prompt ──────────
async function callAgent(apiKey, base64, mimeType, prompt, temperature = 0.1) {
  const res = await fetch(GEMINI_URL(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { maxOutputTokens: 1500, temperature },
      safetySettings: SAFETY,
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Agent tidak menghasilkan teks. Alasan: ${data?.candidates?.[0]?.finishReason}`);
  return text;
}

// ── Ekstrak JSON dari teks response ──────────────────────────
function extractJSON(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  try { return JSON.parse(text); } catch {}
  return null;
}

// ════════════════════════════════════════════════════════════════
// 8 PROMPT AGENT SPESIALIS
// ════════════════════════════════════════════════════════════════

// AGENT 1 — Spesialis: Content Router + Origin Authenticity (D1)
const AGENT_ORIGIN = (file) => `
Anda adalah UVIA Agent-1: Spesialis ORIGIN AUTHENTICITY.
Tugas TUNGGAL: Identifikasi Content Class dan analisis keaslian asal piksel.
Fokus HANYA pada D1. Abaikan aspek lain.

FILE: ${file}

LANGKAH 1 — TENTUKAN CONTENT CLASS:
Pilih SATU yang paling dominan:
CC-A Portrait/Human | CC-B Landscape/Nature | CC-C Aerial/Drone
CC-D Wildlife/Action | CC-E Documentary | CC-F Product/Food
CC-G Architecture | CC-H Analog/Archival | CC-I Illustration/Abstract
CC-J Render/CGI/Game | CC-K Graphic/Typography | CC-L Composite | CC-M Screenshot

Context otomatis:
- CC-H grain=positif | CC-C no-foreground=normal | CC-D blur=nyata
- CC-I/J/K no-camera-physics=normal → D1 = NOT APPLICABLE (skip D1, beri tahu Agent 2 untuk FORCE TRIGGER D3)

LANGKAH 2 — ANALISIS D1 (Not Applicable jika CC-I,J,K):
D1.1 Sensor (40%): sensor_noise_pattern | bayer_demosaic_artifact | highlight_clipping_natural | jpeg_block_artifact | fixed_pattern_noise → score = true_count/5
D1.2 Optik (40%): chromatic_aberration | lens_distortion | optical_vignetting | authentic_lens_flare(skip jika N/A) | focus_plane_physics → score = true_count/applicable
D1.3 Modifier (20%):
  CC-H: film_grain_structure|color_aging_shift|scan_artifact
  CC-C: atmospheric_haze_depth|drone_sensor_noise
  CC-D: motion_blur_directional|rolling_shutter|high_iso_grain
  CC-E: mixed_color_temp|candid_motion_blur|depth_chaos
  Lainnya: 0.50
D1_FINAL = (D1.1×0.40)+(D1.2×0.40)+(D1.3×0.20)
Verdict: ≥0.70=SENSOR AUTHENTIC|0.45-0.69=LIKELY AUTHENTIC|0.25-0.44=AMBIGUOUS|<0.25=NOT DETECTED|N/A

Balas HANYA dalam format JSON:
\`\`\`json
{"content_class":"","context_modifier":[],"D1":{"score":0.00,"verdict":"","applicable":true,"key_findings":""},"traffic_light":"green"}
\`\`\`
`;

// AGENT 2 — Spesialis: Human Involvement (D2) + AI Detection (D3) — REVISED
const AGENT_HUMAN_AI = (file, cc, forceTriggerD3 = false) => `
Anda adalah UVIA Agent-2: Spesialis HUMAN INVOLVEMENT & AI DETECTION.
Tugas TUNGGAL: Ukur keterlibatan manusia (D2) dan deteksi tanda AI generatif (D3).
Fokus HANYA pada D2 dan D3. Abaikan aspek lain.

FILE: ${file} | CONTENT CLASS: ${cc || 'belum diketahui, identifikasi sendiri'}
${forceTriggerD3 ? '⚠️ FORCE TRIGGER D3: Content Class ini WAJIB menjalankan D3 detection secara menyeluruh, bahkan jika D1 terlihat normal.' : ''}

D2 — KETERLIBATAN MANUSIA:
D2.1 Capture (35%): moment_decisive|subject_selection|perspective_intentional|framing_deliberate|light_response
D2.2 Post-Capture (35%): crop_reframe_evidence|local_adjustment|color_grade_applied|element_added|compression_reexport
D2.3 Creative (30%): artistic_decision_visible|imperfection_intentional|narrative_element|signature_style

⚠️ ATURAN BARU WATERMARK:
Deteksi watermark DAN klasifikasikan tipenya:
1. watermark_ai_generated → "Generated by AI", logo generator AI (Gemini, Midjourney, DALL-E), pola SynthID-like
2. watermark_stock → Shutterstock, Getty, Adobe Stock, dll.
3. watermark_artist → tanda tangan seniman, logo studio
4. watermark_foreign → milik pihak ketiga yang tidak dikenal

EFEK PADA SKOR:
- watermark_ai_generated terdeteksi → kurangi D2.2 sebesar 0.30 (pengurangan, bukan ke nol)
- watermark_stock → NETRAL, catat saja
- watermark_artist → NETRAL, bisa jadi seniman asli
- watermark_foreign → catat sebagai catatan

KALKULASI D2:
D2.2_raw = true_count/applicable
D2.2_adjusted = Math.max(0, D2.2_raw - (watermark_ai_generated ? 0.30 : 0))
D2_FINAL = (D2.1×0.35)+(D2.2_adjusted×0.35)+(D2.3×0.30)
Verdict: ≥0.70=HIGH|0.45-0.69=MODERATE|0.25-0.44=LOW|<0.25=MINIMAL

D3 — DETEKSI AI GENERATIF:
⚠️ D3 WAJIB dijalankan jika:
- forceTriggerD3 = true (CC-I/J/K)
- ATAU D1_FINAL < 0.45 (Origin rendah)
- ATAU D2 menunjukkan watermark_ai_generated

D3.1 Artifacts (50%): anatomy_failure|text_incoherence|pattern_repetition|object_merging|background_melting|impossible_lighting|hyper_smooth_skin

D3.2 Style (35%): midjourney_aesthetic|sdxl_noise|dalle_flat|over_cinematic|hyper_detail_blur|face_too_symmetrical|environment_perfect

⚠️ METRIK TAMBAHAN UNTUK CC-I/J/K (ILUSTRASI/RENDER):
Jika CC termasuk CC-I, CC-J, atau CC-K, periksa JUGA:
D3.2_illustration: same_face_syndrome|line_weight_uniform|detail_overload_no_focus|gradient_banding_ai|style_inconsistency_micro
Bobot: 50% D3.2_illustration + 50% D3.2_original

D3.3 Video (15%): temporal_flicker|face_warp|hair_flicker|bg_inconsistency (0.00 jika bukan video)

D3_FINAL = (D3.1×0.50)+(D3.2×0.35)+(D3.3×0.15)
Verdict: ≥0.60=HIGH AI|0.35-0.59=MODERATE|0.15-0.34=LOW|<0.15=MINIMAL

Balas HANYA JSON:
\`\`\`json
{
  "D2": {
    "score": 0.00,
    "verdict": "",
    "key_findings": "",
    "watermark_present": false,
    "watermark_type": "none|ai_generated|stock|artist|foreign",
    "watermark_note": ""
  },
  "D3": {
    "triggered": false,
    "score": 0.00,
    "verdict": "",
    "key_findings": "",
    "force_triggered_for_cc": ${forceTriggerD3 ? 'true' : 'false'}
  },
  "D2_traffic": "green",
  "D3_traffic": "green"
}
\`\`\`
`;

// AGENT 3 — Spesialis: Digital Forensics (D4)
const AGENT_FORENSIC = (file) => `
Anda adalah UVIA Agent-3: Spesialis DIGITAL FORENSICS.
Tugas TUNGGAL: Deteksi manipulasi, splicing, dan deepfake.
Fokus HANYA pada D4. Abaikan aspek lain.
⚠️ Analisis ini bersifat indikatif berbasis visual — TIDAK konklusif secara hukum.

FILE: ${file}

D4.1 Manipulation (30%): clone_stamp_visible|healing_artifact|perspective_inconsistency|scale_error|shadow_direction_mismatch|edge_ghosting → score=true/6
D4.2 Composite/Splicing (30%): lighting_source_conflict|color_temperature_conflict|compression_inconsistency|noise_level_inconsistency|grain_mismatch|resolution_inconsistency → score=true/6
D4.3 Deepfake/Face (25% — HANYA jika ada wajah): face_boundary_artifact|skin_texture_inconsistent|teeth_background_anomaly|ear_hair_merging|facial_symmetry_unnatural → score=true/5 (0.00 jika tidak ada wajah)
D4.4 Context Conflict (15%): timestamp_shadow_conflict|season_environment_conflict|object_anachronism → score=true/3
D4_FINAL = (D4.1×0.30)+(D4.2×0.30)+(D4.3×0.25)+(D4.4×0.15)
Verdict: <0.15=CLEAN|0.15-0.34=LOW CONCERN|0.35-0.59=MODERATE|≥0.60=HIGH CONCERN|≥0.80=CRITICAL

Balas HANYA JSON:
\`\`\`json
{"D4":{"score":0.00,"verdict":"","face_detected":false,"key_findings":""},"traffic_light":"green"}
\`\`\`
`;

// AGENT 4 — Spesialis: Content Safety (D5) + IP Risk (D8)
const AGENT_SAFETY_IP = (file) => `
Anda adalah UVIA Agent-4: Spesialis CONTENT SAFETY & IP RISK.
Tugas TUNGGAL: Periksa keamanan konten dan risiko hak kekayaan intelektual.
Fokus HANYA pada D5 dan D8. Abaikan aspek lain.

FILE: ${file}

D5 — KEAMANAN KONTEN (BINARY — bukan skor):
Hard Blockers (1+ = BLOCKED — berhenti rekomendasikan posting):
explicit_sexual_content|minor_safety_concern|graphic_violence_gore|hate_symbol_visible|self_harm_glorification|illegal_item_prominent
Soft Flags (kontekstual):
nudity_non_explicit|violence_non_graphic|sensitive_historical|political_content|health_misinformation_risk|before_after_body|substance_use_depicted
Privacy:
identifiable_person|location_inferable|private_info_visible|crowd_identifiable
D5_STATUS: CLEAN / MODERATE_RISK / HIGH_RISK / BLOCKED

D8 — RISIKO IP:
D8.1 Copyright risk (hitung true): branded_logo_visible|copyrighted_artwork|licensed_character|music_notation|watermark_foreign
D8.2 Trademark risk: product_brand_prominent|storefront_logo|event_brand
D8.3 Personality risk: celebrity_recognizable|public_figure_context|likeness_commercial_use
D8_TOTAL = semua risk dijumlah
D8_FINAL = MAX(0, 1.00 - (D8_TOTAL × 0.15))
Verdict: ≥0.85=CLEAN|0.70-0.84=LOW|0.50-0.69=MODERATE|<0.50=HIGH|<0.25=CRITICAL

Balas HANYA JSON:
\`\`\`json
{"D5":{"status":"CLEAN","hard_blocks":[],"soft_flags":[],"privacy_flags":[]},"D8":{"score":0.00,"verdict":"","risks_detected":[]},"D5_traffic":"green","D8_traffic":"green"}
\`\`\`
`;

// AGENT 5 — Spesialis: Monetization (D6) + Creative Value (D7)
const AGENT_VALUE = (file, platform) => `
Anda adalah UVIA Agent-5: Spesialis MONETIZATION & CREATIVE VALUE.
Tugas TUNGGAL: Nilai kelayakan monetisasi dan nilai kreatif konten.
Fokus HANYA pada D6 dan D7. Abaikan aspek lain.

FILE: ${file} | PLATFORM TARGET: ${platform}

D6 — MONETISASI:
D6.1 Technical (30%): resolution_adequate|exposure_correct|focus_subject_sharp|composition_functional|color_balance_acceptable → score=true/5
D6.2 Commercial (35%): subject_demand_high|emotional_resonance|versatile_usage|clean_background|universal_appeal → score=true/5
D6.3 Platform ${platform} (35%): pilih indikator paling relevan:
  Stock: model_release_likely|property_release_likely|ai_disclosure_needed|technical_stock_grade
  YouTube: advertiser_friendly|ai_disclosure_needed|reused_content_risk|thumbnail_policy_safe
  Instagram/TikTok: authentic_feel|trend_relevant|ai_label_required
  Marketplace: product_visible|no_misleading|clean_bg|multiple_angle
  Umum: gunakan kombinasi
D6_FINAL = (D6.1×0.30)+(D6.2×0.35)+(D6.3×0.35)
Verdict: ≥0.75=READY|0.55-0.74=READY W/ADJ|0.35-0.54=NEEDS WORK|<0.35=NOT READY

D7 — NILAI KREATIF:
D7.1 Originality (35%): unique_perspective|non_cliche_subject|distinctive_style|unexpected_element
D7.2 Execution (35%): technical_mastery|intentional_aesthetic|cohesive_visual_language|emotional_depth
D7.3 Market (30%): stands_out_in_feed|memorable_single_element|production_value_high|trend_transcendent
D7_FINAL = (D7.1×0.35)+(D7.2×0.35)+(D7.3×0.30)
Verdict: ≥0.75=EXCEPTIONAL|0.55-0.74=STRONG|0.35-0.54=AVERAGE|<0.35=WEAK

Balas HANYA JSON:
\`\`\`json
{"D6":{"score":0.00,"verdict":"","disclosure_needed":false,"key_findings":""},"D7":{"score":0.00,"verdict":"","key_findings":""},"D6_traffic":"green","D7_traffic":"green"}
\`\`\`
`;

// AGENT 6 — Spesialis: Usage Classification (D9) + Narasi + CROSS-REFERENCE
const AGENT_SYNTHESIS = (file, useCase, platform, agentResults, safetyConfig) => `
Anda adalah UVIA Agent-6: Spesialis SYNTHESIS, USAGE CLASSIFICATION & CROSS-REFERENCE.
Tugas TUNGGAL: Baca hasil SEMUA agent (sekarang 8 agent), deteksi kontradiksi,
tentukan D9, buat action plan, dan tulis narasi forensik.

FILE: ${file} | USE CASE: ${useCase} | PLATFORM: ${platform}
SAFETY CONFIG: ${JSON.stringify(safetyConfig || {})}

HASIL DARI SEMUA AGENT:
${JSON.stringify(agentResults, null, 2)}

TUGAS ANDA:

0. DETEKSI KONTRADIKSI (CROSS-REFERENCE) — LAKUKAN PERTAMA:
   Periksa kombinasi berikut dan beri peringatan jika terpicu:

   ⚠️ D1 ≥ 0.70 + D11 ≥ 0.50:
      → "AMBIGUOUS: Foto dengan tanda keaslian TINGGI tapi juga memiliki AI aura signifikan."

   ⚠️ D3 < 0.30 + D11 ≥ 0.60:
      → "AI EVASION SUSPECTED: AI aura tinggi tapi D3 tidak mendeteksi."

   ⚠️ D10 ≥ 0.30 + D3 < 0.30:
      → "SYNTHID/WATERMARK AI TERDETEKSI tapi D3 MINIMAL. D3 under-trigger."

   ⚠️ CC = CC-I/J/K + D2 ≥ 0.80 + D3 < 0.30:
      → "PROBABLE AI MASTERPIECE: Ilustrasi dengan skor human tinggi tapi deteksi AI rendah."

   ⚠️ D10 ≥ 0.50:
      → "SYNTHID LIKELY: Override semua skor human involvement ke LOW."

   ⚠️ SAFETY non-default:
      → "Perhatian: Safety filter API dalam kondisi non-default. Hasil mungkin tidak mencerminkan produksi."

1. Tentukan D9 PRIMARY USE CASE:
   Editorial/Jurnalistik | Komersial/Iklan | Stock Photography | Konten Kreator/Sosmed
   Seni/Portofolio | Dokumentasi/Arsip | Bukti/Forensik | E-Commerce/Produk
   Tidak Direkomendasikan Publik

2. Tentukan D9 secondary (semua yang relevan)

3. Buat ACTION PLAN:
   critical: hal yang HARUS diselesaikan (maks 3, termasuk dari kontradiksi)
   priority: sangat disarankan (maks 3)
   optional: optimasi (maks 2)

4. Tulis NARASI FORENSIK 8-10 kalimat:
   Kalimat 1: Content Class + konteks
   Kalimat 2: Origin D1 + SynthID D10
   Kalimat 3: AI Detection D3 + AI Aura D11
   Kalimat 4: Keterlibatan manusia D2 + watermark
   Kalimat 5: Status forensik D4
   Kalimat 6: Keamanan D5 + IP D8
   Kalimat 7: Monetisasi D6 + Kreatif D7
   Kalimat 8: Klasifikasi D9
   Kalimat 9: TEMUAN KONTRADIKSI (jika ada)
   Kalimat 10: Aksi paling mendesak

Balas HANYA JSON:
\`\`\`json
{
  "D9": {"primary":"","secondary":[],"warnings":[]},
  "cross_reference": {
    "conflicts": [],
    "conflict_details": "",
    "overrides_applied": []
  },
  "action_plan": {"critical":[],"priority":[],"optional":[]},
  "narrative": ""
}
\`\`\`
`;

// AGENT 7 — Spesialis: SynthID & AI Watermark Detection (D10) — BARU
const AGENT_SYNTHID = (file) => `
Anda adalah UVIA Agent-7: Spesialis SYNTHID & AI WATERMARK DETECTION.
Tugas TUNGGAL: Cari tanda watermark generatif AI, baik visual maupun pola tersembunyi.
Fokus HANYA pada D10. Abaikan aspek lain.

FILE: ${file}

⚠️ PENTING: SynthID adalah watermark kriptografis yang disematkan Google pada gambar yang dihasilkan Gemini.
SynthID TIDAK KASAT MATA secara langsung, tapi kadang meninggalkan jejak visual:
- Pola grid/checkerboard sangat halus di area gelap
- Artefak frekuensi tinggi di saluran warna tertentu (biru, merah)
- Tekstur "berulang" yang tidak natural di area latar

Selain SynthID, cari juga WATERMARK AI GENERATIF VISUAL:
- Teks "Generated by", "Created with AI", "AI-generated"
- Logo khas generator (Google AI, Gemini, Imagen)
- Tanda air digital lain yang terlihat

D10.1 SynthID Heuristic (50%): synthid_grid_pattern|synthid_color_channel_artifact|synthid_edge_pattern|synthid_metadata_text_visible → score=true/4
D10.2 AI Watermark Visual (50%): ai_disclaimer_text_visible|ai_generator_logo|ai_watermark_pattern → score=true/3
D10_FINAL = (D10.1×0.50)+(D10.2×0.50)
Verdict: ≥0.60=HIGH|0.30-0.59=MODERATE|0.10-0.29=LOW|<0.10=NONE DETECTED

Balas HANYA JSON:
\`\`\`json
{
  "D10": {
    "score": 0.00,
    "verdict": "",
    "synthid_possible": false,
    "ai_watermark_visible": false,
    "watermark_description": "",
    "key_findings": "",
    "disclaimer": "SynthID detection is heuristic-only. Official decoder required for conclusive verification."
  },
  "traffic_light": "green"
}
\`\`\`
`;

// AGENT 8 — Spesialis: Uncanny Valley & AI Aura (D11) — BARU
const AGENT_UNCANNY = (file, cc) => `
Anda adalah UVIA Agent-8: Spesialis UNCANNY VALLEY & AI AURA DETECTION.
Tugas TUNGGAL: Deteksi "rasa AI" — kesempurnaan yang tidak wajar.
Fokus HANYA pada D11. Abaikan aspek lain.

FILE: ${file} | CONTENT CLASS: ${cc || 'unknown'}

⚠️ KONSEP: Gambar AI sering kali TERLALU SEMPURNA. Kesempurnaan tidak manusiawi ini disebut "Uncanny Valley".

D11.1 OVER-PERFECTION (35%): face_symmetry_too_high|skin_texture_uniform|lighting_calculated|detail_distribution_flat|color_harmony_algorithmic → score=true/5
D11.2 CREATIVE UNIFORMITY (35%): no_micro_inconsistency|style_too_consistent|texture_tiling_visible|edge_sharpness_uniform|ai_signature_style → score=true/5
D11.3 CALCULATED CHAOS (30%): noise_pattern_algorithmic|motion_blur_mathematical|depth_chaos_unnatural|chaos_distribution_even → score=true/4
D11_FINAL = (D11.1×0.35)+(D11.2×0.35)+(D11.3×0.30)
Verdict: ≥0.70=HIGH AI AURA|0.40-0.69=MODERATE|0.15-0.39=LOW|<0.15=NATURAL IMPERFECTION

Balas HANYA JSON:
\`\`\`json
{
  "D11": {
    "score": 0.00,
    "verdict": "",
    "key_findings": "",
    "cross_check_note": ""
  },
  "traffic_light": "green"
}
\`\`\`
`;

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER — UVIA v2.0
// ════════════════════════════════════════════════════════════════
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': event.headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Cek sesi dari cookie (key utama untuk fallback) ──
  const cookieHeader = event.headers.cookie || '';
  const mainKey = getKeyFromCookie(cookieHeader);
  if (!mainKey) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Sesi tidak ditemukan. Silakan login dengan API key terlebih dahulu.' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { images, config } = body;

    if (!images?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Tidak ada gambar.' }) };
    }

    const useCase = config?.useCase || 'Semua';
    const platform = config?.platform || 'Umum';
    const safetyAudit = auditSafety();
    const results = [];

    // ── Kunci per agent (dari env var atau fallback ke cookie) ──
    const keys = {
      A1: getAgentKey('origin', cookieHeader),
      A2: getAgentKey('human_ai', cookieHeader),
      A3: getAgentKey('forensic', cookieHeader),
      A4: getAgentKey('safety_ip', cookieHeader),
      A5: getAgentKey('value', cookieHeader),
      A6: getAgentKey('synthesis', cookieHeader),
      A7: getAgentKey('synthid', cookieHeader),
      A8: getAgentKey('uncanny', cookieHeader),
    };

    // Proses tiap gambar (max 3 sekaligus)
    for (const img of images.slice(0, 3)) {
      const { base64, mimeType, name } = img;

      try {
        // ── FASE 1: 6 Agent PARALEL ──
        const [rawA1, rawA3, rawA4, rawA5, rawA7, rawA8] = await Promise.all([
          callAgent(keys.A1, base64, mimeType, AGENT_ORIGIN(name)),
          callAgent(keys.A3, base64, mimeType, AGENT_FORENSIC(name)),
          callAgent(keys.A4, base64, mimeType, AGENT_SAFETY_IP(name)),
          callAgent(keys.A5, base64, mimeType, AGENT_VALUE(name, platform)),
          callAgent(keys.A7, base64, mimeType, AGENT_SYNTHID(name)),
          callAgent(keys.A8, base64, mimeType, AGENT_UNCANNY(name, '')),
        ]);

        // Parse
        const a1 = extractJSON(rawA1) || {};
        const a3 = extractJSON(rawA3) || {};
        const a4 = extractJSON(rawA4) || {};
        const a5 = extractJSON(rawA5) || {};
        const a7 = extractJSON(rawA7) || {};
        const a8 = extractJSON(rawA8) || {};

        const cc = a1.content_class || 'CC-A';
        const forceTriggerD3 = ['CC-I', 'CC-J', 'CC-K'].includes(cc);

        // ── FASE 2: Agent 2 (butuh CC + force trigger) ──
        const rawA2 = await callAgent(keys.A2, base64, mimeType, AGENT_HUMAN_AI(name, cc, forceTriggerD3));
        const a2 = extractJSON(rawA2) || {};

        // ── FASE 3: Agent 6 — Synthesis + Cross-Reference ──
        const agentResults = {
          agent1_origin: a1,
          agent2_human_ai: a2,
          agent3_forensic: a3,
          agent4_safety_ip: a4,
          agent5_value: a5,
          agent7_synthid: a7,
          agent8_uncanny: a8,
        };
        const rawA6 = await callAgent(keys.A6, base64, mimeType, AGENT_SYNTHESIS(name, useCase, platform, agentResults, safetyAudit), 0.3);
        const a6 = extractJSON(rawA6) || {};

        // ── Gabungkan ──
        const result = {
          file: name,
          version: '2.0',
          content_class: cc,
          context_modifier: a1.context_modifier || [],
          D1: a1.D1 || {},
          D2: a2.D2 || {},
          D3: a2.D3 || {},
          D4: a3.D4 || {},
          D5: a4.D5 || {},
          D6: a5.D6 || {},
          D7: a5.D7 || {},
          D8: a4.D8 || {},
          D9: a6.D9 || {},
          D10: a7.D10 || {},
          D11: a8.D11 || {},
          cross_reference: a6.cross_reference || {},
          risk_matrix: {
            D1: a1.traffic_light || 'yellow',
            D2: a2.D2_traffic || 'yellow',
            D3: a2.D3_traffic || 'green',
            D4: a3.traffic_light || 'green',
            D5: a4.D5_traffic || 'green',
            D6: a5.D6_traffic || 'yellow',
            D7: a5.D7_traffic || 'yellow',
            D8: a4.D8_traffic || 'green',
            D9: 'green',
            D10: a7.traffic_light || 'green',
            D11: a8.traffic_light || 'green',
          },
          action_plan: a6.action_plan || {},
          narrative: a6.narrative || '',
          safety_audit: safetyAudit,
          agent_debug: {
            version: '2.0',
            phases: 3,
            agents_used: 8,
            parallel_in_phase1: 6,
            dimensions: 'D1-D11',
            new_dimensions: ['D10_SynthID', 'D11_UncannyValley'],
            cross_reference: true,
            multi_key: {
              origin: !!process.env.UVIA_KEY_ORIGIN,
              human_ai: !!process.env.UVIA_KEY_HUMAN_AI,
              forensic: !!process.env.UVIA_KEY_FORENSIC,
              safety_ip: !!process.env.UVIA_KEY_SAFETY_IP,
              value: !!process.env.UVIA_KEY_VALUE,
              synthesis: !!process.env.UVIA_KEY_SYNTHESIS,
              synthid: !!process.env.UVIA_KEY_SYNTHID,
              uncanny: !!process.env.UVIA_KEY_UNCANNY,
            }
          }
        };

        results.push({ file: name, parsed: result });

      } catch (imgErr) {
        results.push({ file: name, error: imgErr.message });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results,
        system: 'UVIA v2.0',
        dimensions: 'D1-D11',
        safety_audit: safetyAudit,
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error: ' + err.message })
    };
  }
};
