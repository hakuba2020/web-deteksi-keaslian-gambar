/* =========================================================
   Metadata parser: JPEG (EXIF/XMP/C2PA/DQT), PNG (tEXt/iTXt/zTXt/eXIf/caBX),
   WebP (EXIF/XMP) + pencarian tanda tangan generator AI.
   ========================================================= */
window.Meta = (function () {
  'use strict';
  const latin = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');

  /* Tanda tangan generator AI. points = bobot log-odds menuju "AI". */
  const SIGNATURES = [
    { id: 'iptc-ai', re: /digitalsourcetype\/trainedAlgorithmicMedia/i, points: 7, label: 'IPTC DigitalSourceType: trainedAlgorithmicMedia (dinyatakan dibuat AI)' },
    { id: 'iptc-ai2', re: /(?<![A-Za-z])trainedAlgorithmicMedia/, points: 6, label: 'Penanda "trainedAlgorithmicMedia" (konten dibuat AI)' },
    { id: 'iptc-comp', re: /compositeWithTrainedAlgorithmicMedia/i, points: 3.5, label: 'IPTC: compositeWithTrainedAlgorithmicMedia (sebagian dibuat/diedit AI)' },
    { id: 'iptc-alg', re: /digitalsourcetype\/algorithmicMedia/i, points: 2.5, label: 'IPTC: algorithmicMedia (dibuat secara algoritmik)' },
    { id: 'a1111', re: /Steps: \d+, Sampler: /, points: 7, label: 'Parameter Stable Diffusion (AUTOMATIC1111 / Forge)' },
    { id: 'comfy', re: /"class_type"\s*:\s*"|ComfyUI/, points: 7, label: 'Workflow ComfyUI tertanam' },
    { id: 'invoke', re: /invokeai/i, points: 7, label: 'Metadata InvokeAI' },
    { id: 'fooocus', re: /Fooocus/, points: 7, label: 'Metadata Fooocus' },
    { id: 'novelai', re: /NovelAI/i, points: 7, label: 'Metadata NovelAI' },
    { id: 'mj', re: /Midjourney/i, points: 6.5, label: 'Jejak Midjourney' },
    { id: 'dalle', re: /DALL[·\-• .]?E/i, points: 6.5, label: 'Jejak DALL·E (OpenAI)' },
    { id: 'gptimg', re: /gpt-image|GPT-4o|ChatGPT/i, points: 6, label: 'Jejak ChatGPT / GPT-image (OpenAI)' },
    { id: 'openai', re: /OpenAI/, points: 4.5, label: 'Penyebutan "OpenAI" dalam metadata' },
    { id: 'firefly', re: /Adobe Firefly|Firefly/, points: 5.5, label: 'Jejak Adobe Firefly / Generative Fill' },
    { id: 'google', re: /Made with Google AI|Google Imagen|Imagen [234]|SynthID|Gemini/i, points: 5.5, label: 'Jejak Google Imagen / Gemini / SynthID' },
    { id: 'sd', re: /Stable[ _-]?Diffusion|SDXL|sd_xl|stability\.ai|DreamStudio/i, points: 6, label: 'Jejak Stable Diffusion / Stability AI' },
    { id: 'flux', re: /black-forest-labs|FLUX\.1/i, points: 6, label: 'Jejak FLUX (Black Forest Labs)' },
    { id: 'leonardo', re: /Leonardo\.?Ai/i, points: 6, label: 'Jejak Leonardo.Ai' },
    { id: 'ideogram', re: /Ideogram/i, points: 6, label: 'Jejak Ideogram' },
    { id: 'ms', re: /Bing Image Creator|Microsoft Designer|Image Creator from Microsoft/i, points: 6, label: 'Jejak Microsoft Designer / Bing Image Creator' },
    { id: 'meta', re: /Imagine with Meta|Meta AI/, points: 5, label: 'Jejak Meta AI (Imagine)' },
    { id: 'others', re: /NightCafe|Craiyon|Artbreeder|starryai|Playground ?AI|RunwayML|Recraft|Seedream|Jimeng|Tensor\.Art|SeaArt|PixAI|Kandinsky|Hunyuan|Qwen-Image|Krea\.ai/i, points: 6, label: 'Jejak platform generator AI' },
    { id: 'c2pa-ai', re: /c2pa\.ai_generat|ai_generative_training|"softwareAgent"[^}]{0,80}(AI|Diffusion|Generat)/i, points: 4, label: 'Manifest C2PA menyebut agen AI generatif' },
  ];

  const AI_EDIT_SOFTWARE = /Remini|Facetune|Lensa|FaceApp|Meitu|Picsart AI|Topaz|Luminar Neo/i;
  const EDIT_SOFTWARE = /Photoshop|Lightroom|GIMP|Snapseed|Picsart|Canva|Affinity|Pixelmator|Capture One|VSCO|PicsArt|CapCut|Paint\.NET|Krita/i;

  const EXIF_TAGS = {
    0x010E: 'ImageDescription', 0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
    0x0131: 'Software', 0x0132: 'DateTime', 0x013B: 'Artist', 0x8298: 'Copyright',
    0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8827: 'ISO', 0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized', 0x9209: 'Flash', 0x920A: 'FocalLength', 0x9286: 'UserComment',
    0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension', 0xA420: 'ImageUniqueID',
    0xA433: 'LensMake', 0xA434: 'LensModel', 0xA431: 'BodySerialNumber'
  };
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // Tabel kuantisasi luminans standar JPEG (Annex K)
  const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const STD_LUMA_SUM = STD_LUMA.reduce((a, b) => a + b, 0);

  function detectFormat(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return 'JPEG';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG';
    const s4 = latin.decode(b.subarray(0, 4));
    if (s4 === 'RIFF' && latin.decode(b.subarray(8, 12)) === 'WEBP') return 'WEBP';
    if (s4.startsWith('GIF8')) return 'GIF';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'BMP';
    const ftyp = latin.decode(b.subarray(4, 12));
    if (ftyp.startsWith('ftyp')) {
      const brand = ftyp.slice(4);
      if (/avi[fs]/.test(brand)) return 'AVIF';
      if (/hei[cx]|mif1|msf1|hevc/.test(brand)) return 'HEIC';
    }
    if (s4 === 'II*\u0000' || s4 === 'MM\u0000*') return 'TIFF';
    return 'TIDAK DIKENAL';
  }

  /* ---------- TIFF / EXIF ---------- */
  function parseTIFF(view, start) {
    const out = {};
    const L = view.byteLength;
    if (start + 8 > L) return out;
    const bo = view.getUint16(start);
    const le = bo === 0x4949;
    if (!le && bo !== 0x4D4D) return out;
    const u16 = o => view.getUint16(start + o, le);
    const u32 = o => view.getUint32(start + o, le);
    const i32 = o => view.getInt32(start + o, le);
    const inb = (o, n) => start + o + n <= L && o >= 0;

    function readVal(type, count, off) {
      if (type === 2) {
        let s = '';
        for (let i = 0; i < count; i++) { const c = view.getUint8(start + off + i); if (c === 0) break; s += String.fromCharCode(c); }
        try { s = decodeURIComponent(escape(s)); } catch (e) { /* bukan UTF-8 */ }
        return s.trim();
      }
      if (type === 3) return u16(off);
      if (type === 4) return u32(off);
      if (type === 9) return i32(off);
      if (type === 5) { const d = u32(off + 4); return d ? u32(off) / d : 0; }
      if (type === 10) { const d = i32(off + 4); return d ? i32(off) / d : 0; }
      if (type === 7) {
        const n = Math.min(count, 2000);
        const bytes = new Uint8Array(view.buffer, view.byteOffset + start + off, n);
        let s = latin.decode(bytes);
        if (/^(ASCII|UNICODE|JIS)?\0*/.test(s.slice(0, 8))) s = s.slice(8);
        return s.replace(/\0+/g, ' ').trim();
      }
      return null;
    }

    const seen = new Set();
    function readIFD(off, depth) {
      if (depth > 4 || seen.has(off) || !inb(off, 2)) return;
      seen.add(off);
      const n = u16(off);
      for (let i = 0; i < n && i < 500; i++) {
        const e = off + 2 + i * 12;
        if (!inb(e, 12)) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (tag === 0x8769) { readIFD(u32(e + 8), depth + 1); continue; }
        if (tag === 0x8825) { out.GPS = true; continue; }
        const name = EXIF_TAGS[tag];
        if (!name) continue;
        const size = (TYPE_SIZE[type] || 1) * count;
        const voff = size <= 4 ? e + 8 : u32(e + 8);
        if (!inb(voff, Math.min(size, 4))) continue;
        if (size > 4 && !inb(voff, size)) continue;
        const v = readVal(type, count, voff);
        if (v !== null && v !== '') out[name] = v;
      }
    }
    readIFD(u32(4), 0);
    return out;
  }

  /* ---------- JPEG ---------- */
  function parseJPEG(b, view, res) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD9 || m === 0xDA) break;
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0x00) { i += 2; continue; }
      const len = view.getUint16(i + 2);
      const s = i + 4, e = i + 2 + len;
      if (len < 2 || e > b.length) break;
      const seg = b.subarray(s, e);
      res.segments.push('APP/' + m.toString(16).toUpperCase());
      if (m === 0xE1) {
        const head = latin.decode(seg.subarray(0, 29));
        if (head.startsWith('Exif\0\0')) Object.assign(res.exif, parseTIFF(view, s + 6));
        else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) res.xmp += utf8.decode(seg.subarray(29)) + '\n';
        else if (head.startsWith('http://ns.adobe.com/xmp/extension/')) res.xmp += utf8.decode(seg.subarray(75)) + '\n';
      } else if (m === 0xE2) {
        if (latin.decode(seg.subarray(0, 11)) === 'ICC_PROFILE') res.icc = true;
      } else if (m === 0xEB) {
        if (latin.decode(seg).includes('c2pa')) res.c2pa = true;
      } else if (m === 0xED) {
        res.photoshopIRB = true;
      } else if (m === 0xFE) {
        res.comments.push(utf8.decode(seg));
      } else if (m === 0xDB) {
        let p = 0;
        while (p < seg.length) {
          const pq = seg[p] >> 4, tq = seg[p] & 15; p++;
          const tbl = [];
          for (let k = 0; k < 64 && p < seg.length; k++) {
            if (pq) { tbl.push((seg[p] << 8) | seg[p + 1]); p += 2; } else { tbl.push(seg[p]); p++; }
          }
          res.dqt[tq] = tbl;
        }
      } else if (m === 0xC2) {
        res.progressive = true;
      }
      i = e;
    }
    const t0 = res.dqt[0];
    if (t0 && t0.length === 64) {
      const S = t0.reduce((a, c) => a + c, 0) / STD_LUMA_SUM * 100;
      let q = S <= 100 ? (200 - S) / 2 : 5000 / S;
      res.jpegQuality = Math.max(1, Math.min(100, Math.round(q)));
    }
  }

  /* ---------- PNG ---------- */
  async function inflate(u8) {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      return utf8.decode(await new Response(stream).arrayBuffer());
    } catch (e) { return '[gagal dekompresi]'; }
  }

  async function parsePNG(b, view, res) {
    let i = 8;
    while (i + 12 <= b.length) {
      const len = view.getUint32(i);
      const type = latin.decode(b.subarray(i + 4, i + 8));
      const s = i + 8, e = s + len;
      if (e > b.length) break;
      const d = b.subarray(s, e);
      if (!res.segments.includes(type)) res.segments.push(type);
      if (type === 'tEXt') {
        const z = d.indexOf(0);
        res.text.push({ key: latin.decode(d.subarray(0, z)), value: utf8.decode(d.subarray(z + 1)) });
      } else if (type === 'zTXt') {
        const z = d.indexOf(0);
        res.text.push({ key: latin.decode(d.subarray(0, z)), value: await inflate(d.subarray(z + 2)) });
      } else if (type === 'iTXt') {
        const z = d.indexOf(0);
        const key = latin.decode(d.subarray(0, z));
        const comp = d[z + 1];
        let p = z + 3;
        p = d.indexOf(0, p) + 1; // language tag
        p = d.indexOf(0, p) + 1; // translated keyword
        const value = comp ? await inflate(d.subarray(p)) : utf8.decode(d.subarray(p));
        if (/XML:com\.adobe\.xmp/.test(key)) res.xmp += value + '\n';
        else res.text.push({ key, value });
      } else if (type === 'eXIf') {
        Object.assign(res.exif, parseTIFF(view, s));
      } else if (type === 'caBX') {
        res.c2pa = true;
      } else if (type === 'iCCP') {
        res.icc = true;
      } else if (type === 'IHDR') {
        res.bitDepth = d[8]; res.colorType = d[9];
      } else if (type === 'IEND') break;
      i = e + 4;
    }
  }

  /* ---------- WebP ---------- */
  function parseWEBP(b, view, res) {
    let i = 12;
    while (i + 8 <= b.length) {
      const fourcc = latin.decode(b.subarray(i, i + 4));
      const size = view.getUint32(i + 4, true);
      const s = i + 8, e = s + size;
      if (e > b.length) break;
      res.segments.push(fourcc.trim());
      if (fourcc === 'EXIF') {
        const off = latin.decode(b.subarray(s, s + 6)) === 'Exif\0\0' ? s + 6 : s;
        Object.assign(res.exif, parseTIFF(view, off));
      } else if (fourcc === 'XMP ') {
        res.xmp += utf8.decode(b.subarray(s, e)) + '\n';
      } else if (fourcc === 'C2PA') {
        res.c2pa = true;
      } else if (fourcc === 'ICCP') {
        res.icc = true;
      } else if (fourcc === 'VP8L') {
        res.lossless = true;
      }
      i = e + (size & 1);
    }
  }

  function snippetAround(str, idx, len) {
    const a = Math.max(0, idx - 50), z = Math.min(str.length, idx + len + 70);
    return (a > 0 ? '…' : '') + str.slice(a, z).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '·').replace(/\s+/g, ' ').trim() + (z < str.length ? '…' : '');
  }

  async function parse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const res = {
      format: detectFormat(bytes), exif: {}, xmp: '', text: [], comments: [], dqt: {},
      segments: [], c2pa: false, icc: false, jpegQuality: null, signatures: [],
      editSoftware: null, aiEditSoftware: null, parseError: null
    };
    try {
      if (res.format === 'JPEG') parseJPEG(bytes, view, res);
      else if (res.format === 'PNG') await parsePNG(bytes, view, res);
      else if (res.format === 'WEBP') parseWEBP(bytes, view, res);
    } catch (e) { res.parseError = e.message; }

    // Korpus pencarian: metadata terstruktur + pemindaian biner mentah
    const raw = bytes.length <= 40e6 ? latin.decode(bytes)
      : latin.decode(bytes.subarray(0, 8e6)) + latin.decode(bytes.subarray(bytes.length - 4e6));
    const structured = [
      res.xmp,
      ...res.text.map(t => t.key + ': ' + t.value),
      ...res.comments,
      ...Object.entries(res.exif).filter(([, v]) => typeof v === 'string').map(([k, v]) => k + ': ' + v)
    ].join('\n');

    const found = new Set();
    for (const sig of SIGNATURES) {
      let src = 'metadata', str = structured, m = sig.re.exec(structured);
      if (!m) { m = sig.re.exec(raw); src = 'data biner file'; str = raw; }
      if (!m) continue;
      if (sig.id === 'iptc-ai2' && found.has('iptc-ai')) continue;
      found.add(sig.id);
      res.signatures.push({ id: sig.id, label: sig.label, points: sig.points, src, snippet: snippetAround(str, m.index, m[0].length) });
    }
    if (!res.c2pa && /jumb[\s\S]{0,40}c2pa/.test(raw.slice(0, 2e6))) res.c2pa = true;

    const sw = [res.exif.Software, ...(res.xmp.match(/CreatorTool[="> ]+([^"<\n]+)/) || []).slice(1)].filter(Boolean).join(' ');
    if (AI_EDIT_SOFTWARE.test(sw)) res.aiEditSoftware = sw.match(AI_EDIT_SOFTWARE)[0];
    if (EDIT_SOFTWARE.test(sw)) res.editSoftware = sw.match(EDIT_SOFTWARE)[0];
    res.softwareString = sw;
    return res;
  }

  return { parse, detectFormat };
})();
