// netlify/functions/analyze.js
// ═══════════════════════════════════════════════════════════════
// UVIA MULTI-AGENT SYSTEM
// 6 Agent Spesialis berjalan PARALEL — bukan satu per satu
// Setiap agent punya prompt dan "otak" sendiri
// Hasil digabung oleh Aggregator
// ═══════════════════════════════════════════════════════════════

const { getKeyFromCookie } = require('./session');

const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

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
      generationConfig: { maxOutputTokens: 1200, temperature },
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
// 6 PROMPT AGENT SPESIALIS
// Setiap agent fokus hanya pada dimensi miliknya
// ════════════════════════════════════════════════════════════════

// AGENT 1 — Spesialis: Content Router + Origin Authenticity (D1)
const AGENT_ORIGIN = (file, cc) => `
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

Context otomatis: CC-H grain=positif | CC-C no-foreground=normal | CC-D blur=nyata | CC-I/J no-camera-physics=normal

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

// AGENT 2 — Spesialis: Human Involvement (D2) + AI Detection (D3)
const AGENT_HUMAN_AI = (file, cc) => `
Anda adalah UVIA Agent-2: Spesialis HUMAN INVOLVEMENT & AI DETECTION.
Tugas TUNGGAL: Ukur keterlibatan manusia (D2) dan deteksi tanda AI generatif (D3).
Fokus HANYA pada D2 dan D3. Abaikan aspek lain.

FILE: ${file} | CONTENT CLASS: ${cc || 'belum diketahui, identifikasi sendiri'}

D2 — KETERLIBATAN MANUSIA:
D2.1 Capture (35%): moment_decisive|subject_selection|perspective_intentional|framing_deliberate|light_response
D2.2 Post-Capture (35%): crop_reframe_evidence|local_adjustment|color_grade_applied|element_added|compression_reexport
D2.3 Creative (30%): artistic_decision_visible|imperfection_intentional|narrative_element|signature_style
⚠️ watermark dicatat tapi TIDAK menaikkan skor. Chaos konteks dokumenter = nilai positif.
D2_FINAL = (D2.1×0.35)+(D2.2×0.35)+(D2.3×0.30)
Verdict: ≥0.70=HIGH|0.45-0.69=MODERATE|0.25-0.44=LOW|<0.25=MINIMAL

D3 — DETEKSI AI GENERATIF (HANYA jalankan jika D1 kemungkinan rendah ATAU CC=I/J):
Jika tidak perlu → set triggered:false, score:0.00
D3.1 Artifacts (50%): anatomy_failure|text_incoherence|pattern_repetition|object_merging|background_melting|impossible_lighting|hyper_smooth_skin
D3.2 Style (35%): midjourney_aesthetic|sdxl_noise|dalle_flat|over_cinematic|hyper_detail_blur|face_too_symmetrical|environment_perfect
D3.3 Video (15%): temporal_flicker|face_warp|hair_flicker|bg_inconsistency (0.00 jika bukan video)
D3_FINAL = (D3.1×0.50)+(D3.2×0.35)+(D3.3×0.15)
Verdict: ≥0.60=HIGH AI|0.35-0.59=MODERATE|0.15-0.34=LOW|<0.15=MINIMAL

Balas HANYA JSON:
\`\`\`json
{"D2":{"score":0.00,"verdict":"","key_findings":"","watermark_present":false},"D3":{"triggered":false,"score":0.00,"verdict":"","key_findings":""},"D2_traffic":"green","D3_traffic":"green"}
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

// AGENT 6 — Spesialis: Usage Classification (D9) + Narasi Akhir
const AGENT_SYNTHESIS = (file, useCase, platform, agentResults) => `
Anda adalah UVIA Agent-6: Spesialis SYNTHESIS & USAGE CLASSIFICATION.
Tugas TUNGGAL: Baca hasil 5 agent lain, tentukan klasifikasi penggunaan (D9),
buat action plan, dan tulis narasi forensik.

FILE: ${file} | USE CASE: ${useCase} | PLATFORM: ${platform}

HASIL DARI AGENT LAIN (sudah dianalisis paralel):
${JSON.stringify(agentResults, null, 2)}

TUGAS ANDA:
1. Tentukan D9 PRIMARY USE CASE berdasarkan profil di atas:
   Editorial/Jurnalistik | Komersial/Iklan | Stock Photography | Konten Kreator/Sosmed
   Seni/Portofolio | Dokumentasi/Arsip | Bukti/Forensik | E-Commerce/Produk
   Tidak Direkomendasikan Publik

2. Tentukan D9 secondary (semua yang relevan)

3. Buat ACTION PLAN:
   critical: hal yang HARUS diselesaikan sebelum posting (maks 2)
   priority: sangat disarankan diperbaiki (maks 3)
   optional: optimasi opsional (maks 2)

4. Tulis NARASI FORENSIK 6-8 kalimat yang menggabungkan semua temuan:
   Kalimat 1: Content Class dan konteks
   Kalimat 2: Origin D1 dan AI Detection D3
   Kalimat 3: Keterlibatan manusia D2 dan buktinya
   Kalimat 4: Status forensik D4
   Kalimat 5: Keamanan D5 dan monetisasi D6
   Kalimat 6: Nilai kreatif D7 dan risiko IP D8
   Kalimat 7: Rekomendasi penggunaan D9
   Kalimat 8: Satu aksi paling mendesak

Balas HANYA JSON:
\`\`\`json
{
  "D9": {"primary":"","secondary":[],"warnings":[]},
  "action_plan": {"critical":[],"priority":[],"optional":[]},
  "narrative": ""
}
\`\`\`
`;

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER
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

  // ── Cek sesi dari cookie ──
  const apiKey = getKeyFromCookie(event.headers.cookie || '');
  if (!apiKey) {
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
    const results = [];

    // Proses tiap gambar (max 3 sekaligus)
    for (const img of images.slice(0, 3)) {
      const { base64, mimeType, name } = img;

      try {
        // ── FASE 1: Jalankan Agent 1 dulu untuk dapat Content Class ──
        // (agent lain butuh info CC)
        const [rawA1, rawA3, rawA4, rawA5] = await Promise.all([
          callAgent(apiKey, base64, mimeType, AGENT_ORIGIN(name, '')),
          callAgent(apiKey, base64, mimeType, AGENT_FORENSIC(name)),
          callAgent(apiKey, base64, mimeType, AGENT_SAFETY_IP(name)),
          callAgent(apiKey, base64, mimeType, AGENT_VALUE(name, platform)),
        ]);

        // Parse hasil Agent 1 untuk dapat CC
        const a1 = extractJSON(rawA1) || {};
        const cc = a1.content_class || 'CC-A';

        // ── FASE 2: Agent 2 berjalan setelah CC diketahui ──
        // (Agent 2 butuh CC untuk konteks AI detection yang tepat)
        const rawA2 = await callAgent(apiKey, base64, mimeType, AGENT_HUMAN_AI(name, cc));
        const a2 = extractJSON(rawA2) || {};

        // Parse semua agent lain
        const a3 = extractJSON(rawA3) || {};
        const a4 = extractJSON(rawA4) || {};
        const a5 = extractJSON(rawA5) || {};

        // ── FASE 3: Agent 6 mensintesis semua hasil ──
        const agentResults = { agent1_origin: a1, agent2_human_ai: a2, agent3_forensic: a3, agent4_safety_ip: a4, agent5_value: a5 };
        const rawA6 = await callAgent(apiKey, base64, mimeType, AGENT_SYNTHESIS(name, useCase, platform, agentResults), 0.3);
        const a6 = extractJSON(rawA6) || {};

        // ── Gabungkan semua hasil menjadi output UVIA ──
        const result = {
          file: name,
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
          },
          action_plan: a6.action_plan || {},
          narrative: a6.narrative || '',
          agent_debug: { phases: 3, agents_used: 6, parallel_in_phase1: 4 }
        };

        results.push({ file: name, parsed: result });

      } catch (imgErr) {
        results.push({ file: name, error: imgErr.message });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
