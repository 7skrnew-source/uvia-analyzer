// netlify/functions/lib/meta.mjs
// Pembaca metadata gambar — bukti yang jauh lebih kuat daripada tebakan visual.
// Mendukung JPEG, PNG, WebP. Membaca: EXIF (kamera), XMP/IPTC DigitalSourceType,
// C2PA/Content Credentials (hanya KEBERADAAN dan pernyataan teksnya; tanda tangan TIDAK diverifikasi),
// dan jejak alat pembuat gambar AI (Stable Diffusion/ComfyUI/InvokeAI/NovelAI, dst).
//
// Folder lib/ sengaja tidak berisi index.mjs agar Netlify tidak menjadikannya endpoint.

import { inflateSync } from 'node:zlib';

const MAX_TEXT = 4000;

// Nama alat AI yang cukup khas untuk dicari di semua teks metadata
const AI_TOOLS_DISTINCT = [
  'midjourney', 'dall-e', 'dall·e', 'dalle', 'stable diffusion', 'firefly', 'imagen', 'chatgpt', 'openai',
  'ideogram', 'comfyui', 'automatic1111', 'novelai', 'invokeai', 'nano banana', 'made with google ai',
  'bing image creator', 'microsoft designer', 'leonardo.ai',
];
// Nama pendek: hanya dicari di kolom perangkat lunak/alat pembuat (rawan salah cocok di data biner)
const AI_TOOLS_SHORT = ['gemini', 'flux', 'sora', 'runway', 'krea', 'sdxl', 'leonardo'];

// Alat penyunting biasa (netral, hanya dicatat)
const EDITORS = ['photoshop', 'lightroom', 'gimp', 'snapseed', 'affinity', 'capture one', 'pixelmator', 'canva', 'picsart', 'facetune'];

const printable = buf => (buf.toString('latin1').match(/[\x20-\x7e]{4,}/g) || []).join('\n');
const clip = s => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

// ── TIFF/EXIF ──────────────────────────────────────────────
function parseTiff(t) {
  const out = { present: false };
  try {
    if (t.length < 8) return out;
    const order = t.toString('latin1', 0, 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return out;
    const u16 = o => (o >= 0 && o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : null);
    const u32 = o => (o >= 0 && o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : null);
    if (u16(2) !== 42) return out;

    const readIfd = off => {
      const n = u16(off);
      if (n == null || n > 300) return [];
      const entries = [];
      for (let i = 0; i < n; i++) {
        const p = off + 2 + i * 12;
        const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
        if (tag == null || type == null || count == null) break;
        entries.push({ tag, type, count, pos: p + 8 });
      }
      return entries;
    };
    const ascii = e => {
      if (!e || e.type !== 2 || e.count <= 0 || e.count > 256) return null;
      const start = e.count <= 4 ? e.pos : u32(e.pos);
      if (start == null || start + e.count > t.length) return null;
      return t.toString('latin1', start, start + e.count).replace(/\0[\s\S]*$/, '').trim() || null;
    };
    const find = (list, tag) => list.find(e => e.tag === tag);

    const ifd0Off = u32(4);
    const ifd0 = readIfd(ifd0Off);
    out.present = ifd0.length > 0;
    out.make = ascii(find(ifd0, 0x010f));
    out.model = ascii(find(ifd0, 0x0110));
    out.software = ascii(find(ifd0, 0x0131));

    const exifPtr = find(ifd0, 0x8769);
    if (exifPtr) {
      const ex = readIfd(u32(exifPtr.pos));
      out.dateTimeOriginal = ascii(find(ex, 0x9003));
      out.hasExposure = !!(find(ex, 0x829a) || find(ex, 0x829d) || find(ex, 0x8827));
      out.lens = ascii(find(ex, 0xa434));
      const uc = find(ex, 0x9286); // UserComment — dipakai WebUI Stable Diffusion untuk JPEG
      if (uc && uc.count > 8 && uc.count < 8000) {
        const start = uc.count <= 4 ? uc.pos : u32(uc.pos);
        if (start != null && start + uc.count <= t.length) {
          const txt = t.subarray(start, start + uc.count).toString('latin1').replace(/\0/g, '');
          if (/Steps:\s*\d+/.test(txt) && /Sampler|CFG scale|Seed:/i.test(txt)) out.sdUserComment = true;
        }
      }
    }
    const gpsPtr = find(ifd0, 0x8825);
    if (gpsPtr) {
      const g = readIfd(u32(gpsPtr.pos));
      out.hasGps = g.some(e => e.tag === 0x0002 || e.tag === 0x0004);
    }
  } catch { /* data rusak: kembalikan apa yang sudah terbaca */ }
  return out;
}

// ── Pengumpul per format ───────────────────────────────────
function walkJpeg(buf, acc) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS: metadata ada sebelum data piksel
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;
    const data = buf.subarray(i + 4, i + 2 + len);
    if (m === 0xe1) {
      if (data.toString('latin1', 0, 6) === 'Exif\0\0') acc.tiff.push(data.subarray(6));
      else if (data.toString('latin1', 0, 28).startsWith('http://ns.adobe.com/xap/1.0/')) {
        acc.xmp.push(data.subarray(29).toString('utf8'));
      }
    } else if (m === 0xeb) {
      const head = data.toString('latin1', 0, 64);
      if (head.includes('jumb') || head.includes('c2pa')) acc.c2pa.push(data);
    } else if (m === 0xfe) {
      acc.text.push({ key: 'comment', value: clip(data.toString('latin1')) });
    }
    i += 2 + len;
  }
}

function walkPng(buf, acc) {
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const start = i + 8, end = start + len;
    if (end + 4 > buf.length) break;
    const data = buf.subarray(start, end);
    if (type === 'IEND') break;
    if (type === 'eXIf') acc.tiff.push(data);
    else if (type === 'caBX') acc.c2pa.push(data);
    else if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) acc.text.push({ key: data.toString('latin1', 0, z), value: clip(data.toString('latin1', z + 1)) });
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        try { acc.text.push({ key: data.toString('latin1', 0, z), value: clip(inflateSync(data.subarray(z + 2)).toString('latin1')) }); } catch { /* abaikan */ }
      }
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0 && z + 3 < data.length) {
        const key = data.toString('latin1', 0, z);
        const compressed = data[z + 1] === 1;
        let p = z + 3;
        for (let n = 0; n < 2 && p < data.length; n++) { const q = data.indexOf(0, p); if (q < 0) { p = data.length; break; } p = q + 1; }
        let body = data.subarray(p);
        if (compressed) { try { body = inflateSync(body); } catch { body = Buffer.alloc(0); } }
        const value = body.toString('utf8');
        if (key === 'XML:com.adobe.xmp') acc.xmp.push(value);
        else acc.text.push({ key, value: clip(value) });
      }
    }
    i = end + 4;
  }
}

function walkWebp(buf, acc) {
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const start = i + 8, end = start + len;
    if (end > buf.length) break;
    const data = buf.subarray(start, end);
    if (type === 'EXIF') acc.tiff.push(data.toString('latin1', 0, 6) === 'Exif\0\0' ? data.subarray(6) : data);
    else if (type === 'XMP ') acc.xmp.push(data.toString('utf8'));
    else if (type === 'C2PA') acc.c2pa.push(data);
    i = end + (len % 2);
  }
}

// ── Analisis ───────────────────────────────────────────────
const dsValues = text => [...text.matchAll(/digitalsourcetype\/([a-z]+)/gi)].map(m => m[1].toLowerCase());

function findTools(text, includeShort) {
  const low = text.toLowerCase();
  const found = new Set();
  for (const name of AI_TOOLS_DISTINCT) if (low.includes(name)) found.add(name);
  if (includeShort) {
    for (const name of AI_TOOLS_SHORT) if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(low)) found.add(name);
  }
  return [...found];
}

export function parseMetadata(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  const r = {
    format: null,
    exif: { present: false },
    xmp: { present: false, creatorTool: null },
    c2pa: { present: false },
    sourceTypes: [],
    generatorTags: [],
    aiToolNames: [],
    editors: [],
    declaredAI: false,
    declaredEdited: false,
    declaredCamera: false,
    cameraLike: false,
  };
  const acc = { tiff: [], xmp: [], c2pa: [], text: [] };

  try {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) { r.format = 'jpeg'; walkJpeg(buf, acc); }
    else if (buf.length > 16 && buf.toString('latin1', 1, 4) === 'PNG') { r.format = 'png'; walkPng(buf, acc); }
    else if (buf.length > 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { r.format = 'webp'; walkWebp(buf, acc); }
  } catch { /* lanjutkan dengan yang terkumpul */ }

  // EXIF
  for (const t of acc.tiff) {
    const ex = parseTiff(t);
    if (ex.present) { r.exif = ex; break; }
  }

  // XMP
  const xmpText = acc.xmp.join('\n');
  if (xmpText) {
    r.xmp.present = true;
    const ct = xmpText.match(/xmp:creatortool(?:="|>)([^"<]{1,120})/i);
    r.xmp.creatorTool = ct ? ct[1].trim() : null;
  }

  // C2PA / Content Credentials
  let c2paText = '';
  if (acc.c2pa.length) {
    r.c2pa.present = true;
    c2paText = acc.c2pa.map(printable).join('\n');
  }

  // Jenis sumber (IPTC DigitalSourceType) dari XMP dan C2PA
  const types = new Set([...dsValues(xmpText), ...dsValues(c2paText)]);
  r.sourceTypes = [...types];
  r.declaredAI = types.has('trainedalgorithmicmedia');
  r.declaredEdited = types.has('compositewithtrainedalgorithmicmedia') || types.has('compositesynthetic') || types.has('algorithmicallyenhanced');
  r.declaredCamera = types.has('digitalcapture') || types.has('computationalcapture');

  // Jejak alat pembuat AI
  const tags = new Set();
  if (r.exif.sdUserComment) tags.add('Stable Diffusion (WebUI)');
  for (const { key, value } of acc.text) {
    const k = key.toLowerCase();
    if (k === 'parameters' && /Steps:\s*\d+/.test(value) && /Sampler|CFG scale|Seed:/i.test(value)) tags.add('Stable Diffusion (WebUI)');
    if (k === 'prompt' && value.includes('"class_type"')) tags.add('ComfyUI');
    if (k === 'workflow' && value.includes('"nodes"')) tags.add('ComfyUI');
    if (k === 'invokeai_metadata' || k === 'invokeai_graph' || k === 'sd-metadata' || k === 'dream') tags.add('InvokeAI');
    if (k === 'software' && /novelai/i.test(value)) tags.add('NovelAI');
    if (k === 'comment' && /Steps:\s*\d+/.test(value) && /Sampler/i.test(value)) tags.add('Stable Diffusion (WebUI)');
  }
  r.generatorTags = [...tags];

  const toolText = [r.exif.software, r.xmp.creatorTool, ...acc.text.filter(t => /^(software|source|generator)$/i.test(t.key)).map(t => t.value)].filter(Boolean).join('\n');
  r.aiToolNames = [...new Set([...findTools(toolText, true), ...findTools(c2paText, false), ...findTools(xmpText, false)])];

  const editorText = `${r.exif.software || ''} ${r.xmp.creatorTool || ''}`.toLowerCase();
  r.editors = EDITORS.filter(e => editorText.includes(e));

  r.cameraLike = !!(
    r.exif.present && r.exif.make && r.exif.model &&
    (r.exif.hasExposure || r.exif.dateTimeOriginal) &&
    !r.aiToolNames.length && !r.generatorTags.length && !r.declaredAI
  );

  return r;
}

// Ringkasan aman untuk dikirim ke browser (tanpa koordinat GPS atau isi prompt)
export function summarizeMetadata(m) {
  return {
    format: m.format,
    camera: m.exif.make || m.exif.model ? [m.exif.make, m.exif.model].filter(Boolean).join(' ') : null,
    software: m.exif.software || m.xmp.creatorTool || null,
    taken_at: m.exif.dateTimeOriginal || null,
    has_exposure_data: !!m.exif.hasExposure,
    has_gps: !!m.exif.hasGps,
    has_exif: !!m.exif.present,
    has_xmp: !!m.xmp.present,
    has_c2pa: !!m.c2pa.present,
    source_types: m.sourceTypes,
    ai_tools: m.aiToolNames,
    generator_tags: m.generatorTags,
    editors: m.editors,
  };
}
