// netlify/functions/lib/meta.mjs
// Pembaca metadata gambar — bukti yang jauh lebih kuat daripada tebakan visual.
// Mendukung JPEG, PNG, WebP, HEIC/HEIF, AVIF. Membaca: EXIF (kamera), XMP/IPTC DigitalSourceType,
// C2PA/Content Credentials (hanya KEBERADAAN dan isinya; tanda tangan TIDAK diverifikasi),
// dan jejak alat pembuat gambar AI (Stable Diffusion/ComfyUI/InvokeAI/NovelAI, dst).
//
// Nama alat AI HANYA dicari di kolom alat/perangkat lunak (CreatorTool, Software, softwareAgent,
// claim_generator), dengan batas kata. Teks bebas seperti judul, deskripsi, dan keyword
// tidak pernah dipakai: "Foto scattata dalle montagne" atau "Una imagen del mar" bukan bukti AI.
//
// Folder lib/ sengaja tidak berisi index.mjs agar Netlify tidak menjadikannya endpoint.

import { inflateSync } from 'node:zlib';
import { detectFormat, bmffBoxes, bmffItems, isXmpItem } from '../../../shared/meta-ranges.mjs';

const MAX_TEXT = 4000;
const MAX_SPARSE = 16 * 1024 * 1024;

const AI_TOOLS = [
  'midjourney', 'dall-e', 'dall·e', 'dalle', 'stable diffusion', 'stability ai', 'dreamstudio', 'sdxl',
  'firefly', 'imagen', 'gemini', 'nano banana', 'chatgpt', 'openai', 'gpt-4o', 'gpt-image',
  'ideogram', 'comfyui', 'automatic1111', 'novelai', 'invokeai', 'flux', 'sora', 'runway', 'krea',
  'leonardo.ai', 'leonardo', 'bing image creator', 'microsoft designer', 'playground ai', 'craiyon', 'grok',
];

// Alat penyunting biasa (netral, hanya dicatat)
const EDITORS = ['photoshop', 'lightroom', 'gimp', 'snapseed', 'affinity', 'capture one', 'pixelmator', 'canva', 'picsart', 'facetune'];

const clip = s => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOOL_RE = AI_TOOLS.map(name => [name, new RegExp(`(?:^|[^\\p{L}\\p{N}])${escRe(name)}(?:[^\\p{L}\\p{N}]|$)`, 'iu')]);

function findTools(values) {
  const found = new Set();
  for (const v of values) {
    if (!v) continue;
    for (const [name, re] of TOOL_RE) if (re.test(v)) found.add(name);
  }
  // "leonardo" dan "leonardo.ai" adalah alat yang sama
  if (found.has('leonardo.ai')) found.delete('leonardo');
  return [...found];
}

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
      entries.next = u32(off + 2 + n * 12);
      return entries;
    };
    const ascii = e => {
      if (!e || e.type !== 2 || e.count <= 0 || e.count > 256) return null;
      const start = e.count <= 4 ? e.pos : u32(e.pos);
      if (start == null || start + e.count > t.length) return null;
      return t.toString('latin1', start, start + e.count).replace(/\0[\s\S]*$/, '').trim() || null;
    };
    const find = (list, tag) => list.find(e => e.tag === tag);

    const ifd0 = readIfd(u32(4));
    out.present = ifd0.length > 0;
    out.make = ascii(find(ifd0, 0x010f));
    out.model = ascii(find(ifd0, 0x0110));
    out.software = ascii(find(ifd0, 0x0131));
    // IFD1 = thumbnail bawaan kamera/ponsel (jarang ditambahkan saat memalsukan EXIF)
    out.hasThumbnail = !!(ifd0.next && readIfd(ifd0.next).length);

    const exifPtr = find(ifd0, 0x8769);
    if (exifPtr) {
      const ex = readIfd(u32(exifPtr.pos));
      out.dateTimeOriginal = ascii(find(ex, 0x9003));
      const fields = { exposureTime: 0x829a, fNumber: 0x829d, iso: 0x8827, focalLength: 0x920a };
      out.exposureFields = Object.values(fields).filter(tag => find(ex, tag)).length;
      out.hasExposure = out.exposureFields > 0;
      out.hasMakerNote = !!find(ex, 0x927c);
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
  const extXmp = new Map(); // GUID → [{ offset, data }]
  const jumbf = new Map(); // instance (En) → [{ seq, data }]
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
      else if (data.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') acc.xmp.push(data.subarray(29).toString('utf8'));
      else if (data.toString('latin1', 0, 35) === 'http://ns.adobe.com/xmp/extension/\0' && data.length > 75) {
        // Extended XMP: GUID(32) + panjang total(4) + offset(4) + potongan data
        const guid = data.toString('latin1', 35, 67);
        if (!extXmp.has(guid)) extXmp.set(guid, []);
        extXmp.get(guid).push({ offset: data.readUInt32BE(71), data: data.subarray(75) });
      }
    } else if (m === 0xeb && data.length > 16 && data.toString('latin1', 0, 2) === 'JP') {
      // C2PA/JUMBF bisa dipecah ke banyak segmen APP11; segmen lanjutan mengulang header box
      const en = data.readUInt16BE(2), seq = data.readUInt32BE(4);
      if (!jumbf.has(en)) jumbf.set(en, []);
      jumbf.get(en).push({ seq, data: data.subarray(8) });
    } else if (m === 0xfe) {
      acc.text.push({ key: 'comment', value: clip(data.toString('latin1')) });
    }
    i += 2 + len;
  }

  for (const parts of extXmp.values()) {
    parts.sort((a, b) => a.offset - b.offset);
    acc.xmp.push(Buffer.concat(parts.map(p => p.data)).toString('utf8'));
  }
  for (const parts of jumbf.values()) {
    parts.sort((a, b) => a.seq - b.seq);
    const joined = Buffer.concat(parts.map((p, n) => {
      if (n === 0) return p.data;
      const lbox = p.data.length >= 4 ? p.data.readUInt32BE(0) : 0;
      return p.data.subarray(lbox === 1 ? 16 : 8);
    }));
    const head = joined.toString('latin1', 0, 64);
    if (head.includes('jumb') || head.includes('c2pa')) acc.c2pa.push(joined);
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

// HEIC/HEIF/AVIF: EXIF dan XMP disimpan sebagai "item" yang lokasinya dicatat di kotak iloc
function walkBmff(buf, acc) {
  for (const box of bmffBoxes(buf)) {
    if (box.type === 'uuid') {
      const data = buf.subarray(box.dataStart + 16, box.end);
      const head = data.toString('latin1', 0, 64);
      if (head.includes('jumb') || head.includes('c2pa')) acc.c2pa.push(data);
    }
    if (box.type !== 'meta') continue;
    for (const it of bmffItems(buf, box)) {
      const data = Buffer.concat(it.extents.filter(([o, l]) => o + l <= buf.length).map(([o, l]) => buf.subarray(o, o + l)));
      if (!data.length) continue;
      if (it.type === 'Exif' && data.length > 8) {
        const off = data.readUInt32BE(0);
        let tiff = data.subarray(4 + off);
        if (tiff.toString('latin1', 0, 2) !== 'II' && tiff.toString('latin1', 0, 2) !== 'MM') {
          const k = data.indexOf('Exif\0\0', 0, 'latin1');
          tiff = k >= 0 ? data.subarray(k + 6) : tiff;
        }
        acc.tiff.push(tiff);
      } else if (isXmpItem(it)) {
        acc.xmp.push(data.toString('utf8'));
      }
    }
  }
}

// ── C2PA (CBOR) ────────────────────────────────────────────
// Baca string CBOR (major type 3) di posisi p
function cborText(buf, p) {
  if (p >= buf.length) return null;
  const h = buf[p];
  if (h >> 5 !== 3) return null;
  const info = h & 31;
  let len, s = p + 1;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[s]; s += 1; }
  else if (info === 25) { len = buf.readUInt16BE(s); s += 2; }
  else return null;
  if (len > 300 || s + len > buf.length) return null;
  return buf.toString('utf8', s, s + len);
}
const cborKey = key => Buffer.concat([Buffer.from([0x60 + key.length]), Buffer.from(key)]);

// Nilai untuk kunci tertentu: string langsung, atau field "name" di dalam map/array berikutnya
function cborValues(buf, key) {
  const out = [];
  const k = cborKey(key), name = cborKey('name');
  let p = buf.indexOf(k);
  while (p >= 0 && out.length < 40) {
    const v = p + k.length;
    const direct = cborText(buf, v);
    if (direct != null) out.push(direct);
    else {
      const n = buf.subarray(v, v + 200).indexOf(name);
      if (n >= 0) { const s = cborText(buf, v + n + name.length); if (s != null) out.push(s); }
    }
    p = buf.indexOf(k, p + 1);
  }
  return out;
}

// ── XMP ────────────────────────────────────────────────────
// Nilai field XMP, baik bentuk atribut (ns:Field="…") maupun elemen (<ns:Field>…</ns:Field>)
function xmpValues(xmp, field) {
  const f = escRe(field);
  const out = [];
  for (const m of xmp.matchAll(new RegExp(`${f}\\s*=\\s*"([^"]{1,200})"`, 'gi'))) out.push(m[1]);
  for (const m of xmp.matchAll(new RegExp(`<${f}>([\\s\\S]{1,400}?)</${f}>`, 'gi'))) {
    out.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out.filter(Boolean);
}

const dsValues = text => [...text.matchAll(/digitalsourcetype\/([a-z]+)/gi)].map(m => m[1].toLowerCase());

// Bangun ulang file dari potongan metadata yang dikirim browser (offset asli dipertahankan)
export function sparseBuffer(size, parts) {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SPARSE || !Array.isArray(parts)) return null;
  const buf = Buffer.alloc(size);
  for (const part of parts.slice(0, 2000)) {
    if (!Array.isArray(part) || !Number.isInteger(part[0]) || typeof part[1] !== 'string') continue;
    const data = Buffer.from(part[1], 'base64');
    if (part[0] < 0 || part[0] + data.length > size) continue;
    data.copy(buf, part[0]);
  }
  return buf;
}

export function parseMetadata(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  const r = {
    format: null,
    exif: { present: false },
    xmp: { present: false, creatorTool: null },
    c2pa: { present: false, signatureVerified: false },
    sourceTypes: [],
    generatorTags: [],
    aiToolNames: [],
    aiToolsCreator: [],
    aiToolsHistory: [],
    editors: [],
    declaredAI: false,
    declaredEdited: false,
    declaredCamera: false,
    cameraLike: false,
    cameraDetailed: false,
  };
  const acc = { tiff: [], xmp: [], c2pa: [], text: [] };

  try {
    r.format = detectFormat(buf);
    if (r.format === 'jpeg') walkJpeg(buf, acc);
    else if (r.format === 'png') walkPng(buf, acc);
    else if (r.format === 'webp') walkWebp(buf, acc);
    else if (r.format === 'heic' || r.format === 'avif') walkBmff(buf, acc);
  } catch { /* lanjutkan dengan yang terkumpul */ }

  // EXIF
  for (const t of acc.tiff) {
    const ex = parseTiff(t);
    if (ex.present) { r.exif = ex; break; }
  }

  // XMP
  const xmpText = acc.xmp.join('\n');
  const creatorTools = xmpValues(xmpText, 'xmp:CreatorTool');
  const softwareAgents = xmpValues(xmpText, 'stEvt:softwareAgent');
  const credits = xmpValues(xmpText, 'photoshop:Credit');
  if (xmpText) {
    r.xmp.present = true;
    r.xmp.creatorTool = creatorTools[0] || null;
  }

  // C2PA / Content Credentials
  const c2paBuf = Buffer.concat(acc.c2pa);
  const claimGenerators = [];
  const c2paAgents = [];
  if (acc.c2pa.length) {
    r.c2pa.present = true;
    claimGenerators.push(...cborValues(c2paBuf, 'claim_generator'), ...cborValues(c2paBuf, 'claim_generator_info'));
    c2paAgents.push(...cborValues(c2paBuf, 'softwareAgent'));
  }

  // Jenis sumber (IPTC DigitalSourceType) dari XMP dan C2PA
  const types = new Set([...dsValues(xmpText), ...dsValues(c2paBuf.toString('latin1'))]);
  r.sourceTypes = [...types];
  r.declaredAI = types.has('trainedalgorithmicmedia');
  r.declaredEdited = types.has('compositewithtrainedalgorithmicmedia') || types.has('compositesynthetic') || types.has('algorithmicallyenhanced');
  r.declaredCamera = types.has('digitalcapture') || types.has('computationalcapture') || types.has('negativefilm') || types.has('positivefilm');
  // Google: "Made with Google AI" (dibuat) / "Edited with Google AI" (diedit) di kolom Credit
  if (credits.some(c => /\bedited with (google )?ai\b/i.test(c))) r.declaredEdited = true;
  else if (credits.some(c => /\bmade with google ai\b/i.test(c))) r.declaredAI = true;

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

  // Alat pembuat file (CreatorTool/Software/claim_generator) vs alat di riwayat edit (softwareAgent)
  const pngTools = acc.text.filter(t => /^(software|source|generator)$/i.test(t.key)).map(t => t.value);
  const creatorText = [r.exif.software, ...creatorTools, ...claimGenerators, ...pngTools];
  const historyText = [...softwareAgents, ...c2paAgents];
  r.aiToolsCreator = findTools(creatorText);
  r.aiToolsHistory = findTools(historyText).filter(t => !r.aiToolsCreator.includes(t));
  r.aiToolNames = [...r.aiToolsCreator, ...r.aiToolsHistory];
  r.toolStrings = [...new Set([...creatorText, ...historyText].filter(Boolean).map(s => s.slice(0, 80)))].slice(0, 6);

  const editorText = [...creatorText, ...historyText].filter(Boolean).join(' ').toLowerCase();
  r.editors = EDITORS.filter(e => editorText.includes(e));

  // Data kamera. Merek/model/waktu mudah ditambahkan dengan exiftool; MakerNote/thumbnail bawaan
  // dan data eksposur lengkap lebih jarang ikut dipalsukan, jadi dianggap bukti lebih kuat.
  r.cameraLike = !!(
    r.exif.present && r.exif.make && r.exif.model &&
    (r.exif.hasExposure || r.exif.dateTimeOriginal) &&
    !r.aiToolNames.length && !r.generatorTags.length && !r.declaredAI
  );
  r.cameraDetailed = r.cameraLike &&
    (r.exif.hasMakerNote || r.exif.hasThumbnail) &&
    (r.exif.exposureFields || 0) >= 3 &&
    (r.format === 'jpeg' || r.format === 'heic'); // kamera tidak menghasilkan PNG/WebP

  return r;
}

// Ringkasan aman untuk dikirim ke browser (tanpa koordinat GPS atau isi prompt)
export function summarizeMetadata(m) {
  return {
    format: m.format,
    camera: m.exif.make || m.exif.model ? [m.exif.make, m.exif.model].filter(Boolean).join(' ') : null,
    camera_detail: m.cameraDetailed ? 'lengkap' : m.cameraLike ? 'minim' : null,
    software: m.exif.software || m.xmp.creatorTool || null,
    taken_at: m.exif.dateTimeOriginal || null,
    has_exposure_data: !!m.exif.hasExposure,
    has_gps: !!m.exif.hasGps,
    has_exif: !!m.exif.present,
    has_xmp: !!m.xmp.present,
    has_c2pa: !!m.c2pa.present,
    c2pa_signature_verified: false,
    source_types: m.sourceTypes,
    ai_tools: m.aiToolNames,
    generator_tags: m.generatorTags,
    editors: m.editors,
  };
}
