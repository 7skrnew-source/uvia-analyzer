// netlify/functions/lib/verdict.mjs
// Kesimpulan akhir "AI atau bukan?" — dihitung KODE dari bukti metadata + skor visual.
// Prinsip: label tegas hanya jika ada bukti kuat; tebakan visual saja tidak pernah cukup untuk
// menyatakan "hampir pasti". Foto yang tidak punya tanda AI TIDAK dinyatakan "asli" tanpa bukti.

export const LEVELS = {
  ai: {
    label: 'Hampir pasti dibuat AI',
    text: 'Ada bukti kuat yang menunjukkan gambar ini dihasilkan oleh AI.',
  },
  likely_ai: {
    label: 'Kemungkinan besar dibuat AI',
    text: 'Gambar ini menunjukkan beberapa ciri khas hasil AI, tetapi tidak ada bukti pasti di dalam file-nya.',
  },
  edited: {
    label: 'Foto yang diedit dengan AI',
    text: 'File menyatakan sebagian isi gambar ditambah atau diubah dengan bantuan AI.',
  },
  uncertain: {
    label: 'Belum bisa dipastikan',
    text: 'Tanda-tandanya campur aduk. Sebaiknya jangan menyimpulkan apa pun hanya dari alat ini.',
  },
  no_signs: {
    label: 'Tidak ada tanda jelas AI',
    text: 'Kami tidak menemukan tanda kuat AI, tetapi ini belum membuktikan fotonya asli.',
  },
  likely_real: {
    label: 'Kemungkinan besar foto asli',
    text: 'Tidak ada tanda kuat AI, dan data di dalam file cocok dengan foto dari kamera.',
  },
  unknown: {
    label: 'Analisis belum lengkap',
    text: 'Sebagian pemeriksaan gagal sehingga belum ada kesimpulan.',
  },
};

export const NEXT_STEPS = [
  { text: 'Cek "Content Credentials" file ini di verify.contentauthenticity.org', url: 'https://verify.contentauthenticity.org' },
  { text: 'Cari tahu kapan dan di mana foto ini pertama kali muncul (Google Lens)', url: 'https://lens.google.com' },
  { text: 'Bandingkan dengan pencarian gambar terbalik (TinEye)', url: 'https://tineye.com' },
  { text: 'Jika gambar dibuat dengan produk Google, cek watermark SynthID lewat fitur verifikasi di aplikasi Gemini.' },
  { text: 'Minta file aslinya (bukan screenshot) dari orang yang mengirim.' },
];

const bandVisual = (d3, d11) => {
  if (d3 == null && d11 == null) return null;
  if (d3 == null) return d11;
  if (d11 == null) return d3;
  return 0.6 * d3 + 0.4 * d11;
};

export function overallVerdict({ meta, d, category, metaUnavailable = false }) {
  const reasons = [];
  const add = (dir, strength, text) => reasons.push({ dir, strength, text });
  const list = a => a.join(', ');

  // ── 1. Bukti dari dalam file ──────────────────────────
  if (meta.declaredAI) {
    add('ai', 'kuat', 'File ini sendiri menyatakan isinya dibuat oleh AI (tercatat di Content Credentials/metadata).');
  }
  if (meta.generatorTags.length) {
    add('ai', 'kuat', `Metadata berisi jejak program pembuat gambar AI: ${list(meta.generatorTags)}.`);
  }
  if (meta.aiToolNames.length) {
    add('ai', 'kuat', `Nama alat AI tercantum di metadata: ${list(meta.aiToolNames)}.`);
  }
  const marks = d.D10?.visible_marks || [];
  const visibleMark = marks.includes('ai_disclaimer_text_visible') || marks.includes('ai_generator_logo');
  if (visibleMark) {
    add('ai', 'kuat', 'Terlihat tulisan atau logo AI di dalam gambar.');
  }
  if (meta.declaredEdited) {
    add('edit', 'sedang', 'File menyatakan sebagian isinya ditambah atau diubah dengan AI.');
  }

  const strongAI = reasons.some(r => r.dir === 'ai' && r.strength === 'kuat');

  // ── 2. Bukti kamera ───────────────────────────────────
  if (meta.cameraLike) {
    const cam = [meta.exif.make, meta.exif.model].filter(Boolean).join(' ');
    add('real', 'sedang', `Metadata cocok dengan foto dari kamera (${cam}) lengkap dengan data pengambilan. Metadata bisa dipalsukan, jadi ini bukan bukti mutlak.`);
  } else if (meta.c2pa.present && !meta.declaredAI) {
    add('real', 'lemah', 'File membawa Content Credentials tanpa pernyataan AI. Tanda tangannya belum diperiksa di sini; cek lewat tautan verifikasi di bawah.');
  }
  if (meta.editors.length) {
    add('netral', 'lemah', `Foto pernah dibuka di aplikasi penyunting (${list(meta.editors)}). Itu biasa dan bukan tanda AI.`);
  }

  // ── 3. Penilaian visual ───────────────────────────────
  const d3 = d.D3?.score ?? null;
  const d11 = d.D11?.score ?? null;
  const visual = bandVisual(d3, d11);
  if (visual != null) {
    if (visual >= 0.6) add('ai', 'sedang', 'Dari tampilannya, gambar ini banyak memiliki ciri khas hasil AI.');
    else if (visual >= 0.35) add('ai', 'lemah', 'Dari tampilannya, ada beberapa ciri yang mirip hasil AI, tetapi belum meyakinkan.');
    else if (strongAI) add('netral', 'lemah', 'Tampilannya sendiri tidak menunjukkan ciri AI yang kuat. Itu wajar: gambar AI modern sering tampak sangat natural, jadi kesan visual tidak mengubah kesimpulan di atas.');
    else add('real', 'lemah', 'Dari tampilannya, tidak terlihat ciri kuat hasil AI.');
    const note = d.D3?.key_findings || d.D11?.key_findings;
    if (note) add('netral', 'lemah', note);
  }
  if ((d.D4?.score ?? 0) >= 0.6) {
    add('edit', 'sedang', 'Ada tanda gambar diedit berat atau digabung dari beberapa sumber.');
  }
  if (category === 'foto_edit_ai') {
    add('edit', 'lemah', 'Penilaian visual menduga ada bagian foto yang diedit dengan AI (misalnya diperhalus, diperbesar, atau diisi otomatis).');
  }

  // ── 4. Keputusan ──────────────────────────────────────
  let level;
  let confidence;
  if (strongAI) {
    level = 'ai';
    confidence = meta.declaredAI || meta.generatorTags.length ? 'tinggi' : 'sedang';
  } else if (visual == null) {
    level = 'unknown';
    confidence = 'rendah';
  } else if (visual >= 0.6) {
    if (meta.cameraLike) {
      level = 'uncertain';
      confidence = 'rendah';
      add('netral', 'sedang', 'Penilaian visual dan metadata kamera saling bertentangan. Salah satunya bisa keliru.');
    } else {
      level = 'likely_ai';
      confidence = d3 != null && d11 != null && d3 >= 0.6 && d11 >= 0.4 ? 'sedang' : 'rendah';
    }
  } else if (visual >= 0.35) {
    level = 'uncertain';
    confidence = 'rendah';
  } else {
    level = meta.cameraLike ? 'likely_real' : 'no_signs';
    confidence = meta.cameraLike ? 'sedang' : 'rendah';
  }

  const editedWithAI = meta.declaredEdited || category === 'foto_edit_ai';
  if (meta.declaredEdited && (level === 'no_signs' || level === 'likely_real' || level === 'uncertain')) {
    level = 'edited';
    confidence = 'sedang';
  }

  // ── 5. Catatan kejujuran ──────────────────────────────
  const caveats = ['Ini perkiraan dari alat otomatis, bukan bukti pasti. Tidak ada alat pendeteksi AI yang 100% akurat.'];
  if (!meta.exif.present && !meta.xmp.present && !meta.c2pa.present) {
    caveats.push(
      metaUnavailable
        ? 'Metadata asli tidak bisa dibaca dari file ini. Jika punya file aslinya, unggah ulang yang berukuran lebih kecil.'
        : 'File ini tidak membawa metadata. Itu tidak membuktikan apa-apa: screenshot dan unggahan lewat media sosial biasanya menghapusnya.'
    );
  }
  if (level === 'no_signs' || level === 'likely_real') {
    caveats.push('Gambar AI generasi terbaru sering sulit dikenali dari tampilan saja, dan foto asli yang di-retouch berat bisa terlihat seperti hasil AI.');
  }
  if (meta.exif.hasGps) {
    caveats.push('Perhatian privasi: file ini menyimpan data lokasi (GPS). Hapus sebelum dibagikan jika tidak ingin lokasi terlihat.');
  }

  const base = LEVELS[level];
  return {
    level,
    label: base.label,
    explanation: base.text,
    confidence,
    edited_with_ai: editedWithAI,
    reasons,
    caveats,
    next_steps: NEXT_STEPS,
    visual_ai_score: visual == null ? null : Math.round(visual * 100) / 100,
  };
}
