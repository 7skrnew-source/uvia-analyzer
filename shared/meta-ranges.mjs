// shared/meta-ranges.mjs
// Dipakai di BROWSER dan di SERVER (tanpa dependensi Node).
//
// Browser: untuk file besar yang harus dikecilkan, cari bagian file ASLI yang berisi metadata
// (di mana pun letaknya: awal, akhir, atau di tengah) lalu kirim hanya potongan itu.
// Server : menyusun ulang potongan itu pada offset aslinya, lalu membaca metadata seperti biasa.
//
// Format: JPEG, PNG, WebP, dan ISOBMFF (HEIC/HEIF/AVIF).

export const MAX_META_BYTES = 2 * 1024 * 1024; // total potongan metadata yang dikirim
const MAX_PART = 1024 * 1024; // satu chunk/box metadata

const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
const uN = (b, o, n) => (n === 0 ? 0 : n === 2 ? u16(b, o) : n === 4 ? u32(b, o) : n === 8 ? u32(b, o) * 2 ** 32 + u32(b, o + 4) : 0);

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis', 'mif2'];

export function detectFormat(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.length > 16 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b.length > 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length > 16 && ascii(b, 4, 8) === 'ftyp') {
    const size = Math.min(u32(b, 0), b.length, 256);
    const brands = [ascii(b, 8, 12)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, o + 4));
    if (brands.some(x => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some(x => HEIF_BRANDS.includes(x))) return 'heic';
  }
  return null;
}

// ── ISOBMFF ────────────────────────────────────────────────
// Kotak (box) tingkat atas: [{ type, start, dataStart, end }]
export function bmffBoxes(b, start = 0, end = b.length) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = u32(b, i);
    const type = ascii(b, i + 4, i + 8);
    let head = 8;
    if (size === 1) { if (i + 16 > end) break; size = uN(b, i + 8, 8); head = 16; }
    else if (size === 0) size = end - i;
    if (size < head) break;
    out.push({ type, start: i, dataStart: i + head, end: Math.min(i + size, end), fullEnd: i + size });
    i += size;
  }
  return out;
}

// Item metadata di dalam kotak 'meta' (Exif / XMP) beserta lokasi datanya di file
export function bmffItems(b, meta) {
  const items = new Map();
  try {
    const kids = bmffBoxes(b, meta.dataStart + 4, meta.end); // meta = FullBox
    const idat = kids.find(k => k.type === 'idat');

    const iinf = kids.find(k => k.type === 'iinf');
    if (iinf) {
      const v = b[iinf.dataStart];
      const first = iinf.dataStart + 4 + (v === 0 ? 2 : 4);
      for (const infe of bmffBoxes(b, first, iinf.end)) {
        if (infe.type !== 'infe') continue;
        const iv = b[infe.dataStart];
        if (iv < 2) continue;
        let p = infe.dataStart + 4;
        const id = iv === 2 ? u16(b, p) : u32(b, p);
        p += (iv === 2 ? 2 : 4) + 2;
        const type = ascii(b, p, p + 4);
        p += 4;
        const z = b.indexOf(0, p);
        let contentType = '';
        if (type === 'mime' && z >= 0 && z < infe.end) {
          const z2 = b.indexOf(0, z + 1);
          contentType = ascii(b, z + 1, z2 > 0 && z2 < infe.end ? z2 : infe.end);
        }
        items.set(id, { id, type, contentType, extents: [] });
      }
    }

    const iloc = kids.find(k => k.type === 'iloc');
    if (iloc) {
      const v = b[iloc.dataStart];
      let p = iloc.dataStart + 4;
      const offSize = b[p] >> 4, lenSize = b[p] & 15, baseSize = b[p + 1] >> 4;
      const idxSize = v === 1 || v === 2 ? b[p + 1] & 15 : 0;
      p += 2;
      const count = v < 2 ? u16(b, p) : u32(b, p);
      p += v < 2 ? 2 : 4;
      for (let n = 0; n < count && p < iloc.end; n++) {
        const id = v < 2 ? u16(b, p) : u32(b, p);
        p += v < 2 ? 2 : 4;
        let method = 0;
        if (v === 1 || v === 2) { method = u16(b, p) & 15; p += 2; }
        p += 2; // data_reference_index
        const base = uN(b, p, baseSize);
        p += baseSize;
        const ec = u16(b, p);
        p += 2;
        const item = items.get(id);
        for (let e = 0; e < ec; e++) {
          p += idxSize;
          const off = uN(b, p, offSize); p += offSize;
          const len = uN(b, p, lenSize); p += lenSize;
          if (!item) continue;
          const origin = method === 1 ? (idat ? idat.dataStart : -1) : method === 0 ? 0 : -1;
          if (origin >= 0) item.extents.push([origin + base + off, len]);
        }
      }
    }
  } catch { /* struktur rusak: kembalikan yang sudah terbaca */ }
  return [...items.values()];
}

export const isXmpItem = it => it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType);

// ── Rentang byte yang berisi metadata ──────────────────────
// Mengembalikan [[start, end], ...] (sudah digabung dan dibatasi MAX_META_BYTES).
export function metadataRanges(b) {
  const format = detectFormat(b);
  const r = [];
  const add = (s, e) => { if (e > s) r.push([s, Math.min(e, b.length)]); };
  const addCapped = (s, e) => add(s, Math.min(e, s + MAX_PART));

  if (format === 'jpeg') {
    // Semua segmen sebelum data piksel (SOS): EXIF, XMP + Extended XMP, C2PA (APP11), komentar, ukuran (SOF)
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xda || m === 0xd9) { i += 2; break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      i += 2 + u16(b, i + 2);
    }
    add(0, Math.min(i, b.length));
  } else if (format === 'png') {
    // Header setiap chunk (agar struktur bisa ditelusuri) + isi chunk selain data piksel,
    // termasuk teks yang ditulis SETELAH data gambar
    add(0, 8);
    let i = 8;
    while (i + 8 <= b.length) {
      const len = u32(b, i);
      const type = ascii(b, i + 4, i + 8);
      if (type === 'IDAT' || type === 'fdAT') add(i, i + 8);
      else addCapped(i, i + 12 + len);
      if (type === 'IEND') break;
      i += 12 + len;
    }
  } else if (format === 'webp') {
    add(0, 12);
    let i = 12;
    while (i + 8 <= b.length) {
      const type = ascii(b, i, i + 4);
      const len = u32le(b, i + 4);
      if (['VP8 ', 'VP8L', 'ALPH', 'ANMF'].includes(type)) add(i, i + 8);
      else addCapped(i, i + 8 + len);
      i += 8 + len + (len % 2);
    }
  } else if (format === 'heic' || format === 'avif') {
    for (const box of bmffBoxes(b)) {
      if (box.type === 'mdat' || box.type === 'free' || box.type === 'skip') add(box.start, box.dataStart);
      else addCapped(box.start, box.fullEnd);
      if (box.type === 'meta') {
        for (const it of bmffItems(b, box)) {
          if (it.type === 'Exif' || isXmpItem(it)) for (const [o, l] of it.extents) addCapped(o, o + l);
        }
      }
    }
  } else {
    add(0, 256 * 1024); // format tak dikenal: kirim bagian awal saja
  }

  // Gabungkan, urutkan, batasi total
  r.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s, e] of r) {
    const last = merged.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let budget = MAX_META_BYTES;
  const out = [];
  for (const [s, e] of merged) {
    if (budget <= 0) break;
    const end = Math.min(e, s + budget);
    out.push([s, end]);
    budget -= end - s;
  }
  return { format, ranges: out };
}
