/* =========================================================
   Analisis sinyal:
   - Jejak CFA / demosaicing sensor kamera (pola Bayer)
   - Watermark tak terlihat Stable Diffusion (invisible-watermark, metode dwtDct)
   - Kompresi JPEG ganda (histogram koefisien DCT)
   - Histogram warna
   ========================================================= */
window.Signal = (function () {
  'use strict';

  function canvasOf(img, sx, sy, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    return x.getImageData(0, 0, w, h);
  }

  /* Piksel resolusi asli (dipakai ulang dari kanvas kerja bila tidak diperkecil) */
  function nativeData(img, work) {
    if (work && work.scale === 1) return work.data;
    return canvasOf(img, 0, 0, img.naturalWidth, img.naturalHeight);
  }

  /* ---------------------------------------------------------
     1. CFA (Color Filter Array)
     Sensor kamera hanya merekam satu warna per piksel (pola Bayer);
     dua warna lainnya diinterpolasi. Akibatnya residu prediksi kanal hijau
     pada kisi quincunx "genap" dan "ganjil" memiliki varians berbeda.
     Gambar sintetis (AI) tidak memiliki asimetri ini.
     --------------------------------------------------------- */
  function cfa(img) {
    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    const N = Math.min(1024, W0, H0) & ~1;
    if (N < 128) return null;
    const sx = ((W0 - N) >> 1) & ~1, sy = ((H0 - N) >> 1) & ~1; // offset genap → fase Bayer terjaga
    const d = canvasOf(img, sx, sy, N, N).data;
    const G = new Float32Array(N * N);
    for (let i = 0, j = 0; j < G.length; i += 4, j++) G[j] = d[i + 1];

    const B = 32, logs = [];
    let tot0 = 0, tot1 = 0;
    for (let by = 1; by + B < N; by += B) {
      for (let bx = 1; bx + B < N; bx += B) {
        let s0 = 0, q0 = 0, n0 = 0, s1 = 0, q1 = 0, n1 = 0, gm = 0;
        for (let y = by; y < by + B; y++) {
          for (let x = bx; x < bx + B; x++) {
            const k = y * N + x;
            const e = G[k] - (G[k - 1] + G[k + 1] + G[k - N] + G[k + N]) / 4;
            gm += G[k];
            if ((x + y) & 1) { s1 += e; q1 += e * e; n1++; } else { s0 += e; q0 += e * e; n0++; }
          }
        }
        gm /= B * B;
        if (gm < 8 || gm > 247) continue;
        const v0 = q0 / n0 - (s0 / n0) ** 2, v1 = q1 / n1 - (s1 / n1) ** 2;
        if (v0 + v1 < 0.5) continue; // blok terlalu datar
        logs.push(Math.log((v0 + 1e-3) / (v1 + 1e-3)));
        tot0 += v0; tot1 += v1;
      }
    }
    if (logs.length < 12) return { blocks: logs.length, ratio: 1, consistency: 0, level: 'na' };
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sign = Math.sign(mean) || 1;
    const consistency = logs.filter(v => Math.sign(v) === sign).length / logs.length;
    const ratio = Math.exp(Math.abs(mean));
    let level = 'none';
    if (ratio >= 1.15 && consistency >= 0.8) level = 'strong';
    else if (ratio >= 1.05 && consistency >= 0.7) level = 'weak';
    return { blocks: logs.length, ratio, consistency, level, phase: sign > 0 ? 'genap' : 'ganjil', N };
  }

  /* ---------------------------------------------------------
     2. Watermark tak terlihat (library invisible-watermark, metode dwtDct)
     Dipakai skrip resmi Stable Diffusion v1/v2 ("StableDiffusionV1")
     dan pipeline SDXL (pesan 48 bit). Penyisipan: BGR→YUV (OpenCV),
     kanal U, Haar DWT level-1 (LL), blok 4×4, koefisien |maks| non-DC
     dikuantisasi dengan skala 36.
     --------------------------------------------------------- */
  const SDXL_BITS = '101100111110110010010000011110111011000110011110'.split('').map(Number);
  const SD1_BITS = [...new TextEncoder().encode('StableDiffusionV1')].flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (b >> i) & 1));
  const WM_SCALE = 36;

  function watermark(img, work) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w < 256 || h < 256) return { checked: false, reason: 'Gambar < 256 px' };
    if (w * h > 50e6) return { checked: false, reason: 'Gambar terlalu besar' };
    const d = nativeData(img, work).data;
    const r4 = h - (h % 4), c4 = w - (w % 4);
    // kanal U ala OpenCV (8-bit): U = 0.492·(B − Y) + 128, dibulatkan & dijenuhkan
    const U = new Float32Array(r4 * c4);
    for (let y = 0; y < r4; y++) {
      for (let x = 0; x < c4; x++) {
        const i = (y * w + x) * 4;
        const Y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        U[y * c4 + x] = Math.max(0, Math.min(255, Math.round(0.492 * (d[i + 2] - Y) + 128)));
      }
    }
    // Haar DWT: LL = (a+b+c+d)/2
    const hr = r4 / 2, hc = c4 / 2;
    const LL = new Float32Array(hr * hc);
    for (let y = 0; y < hr; y++) for (let x = 0; x < hc; x++) {
      const a = (2 * y) * c4 + 2 * x;
      LL[y * hc + x] = (U[a] + U[a + 1] + U[a + c4] + U[a + c4 + 1]) / 2;
    }
    const lens = [SDXL_BITS.length, SD1_BITS.length];
    const sums = lens.map(n => new Float64Array(n)), cnts = lens.map(n => new Float64Array(n));
    const br = Math.floor(hr / 4), bc = Math.floor(hc / 4);
    let num = 0;
    for (let i = 0; i < br; i++) {
      for (let j = 0; j < bc; j++) {
        let best = -1, bestAbs = -1;
        for (let k = 1; k < 16; k++) {
          const v = Math.abs(LL[(i * 4 + (k >> 2)) * hc + j * 4 + (k & 3)]);
          if (v > bestAbs) { bestAbs = v; best = k; }
        }
        const bit = (bestAbs % WM_SCALE) > 0.5 * WM_SCALE ? 1 : 0;
        for (let t = 0; t < lens.length; t++) { const p = num % lens[t]; sums[t][p] += bit; cnts[t][p]++; }
        num++;
      }
    }
    const match = (t, ref) => {
      let ok = 0;
      for (let p = 0; p < ref.length; p++) if (((sums[t][p] / cnts[t][p]) * 255 > 127 ? 1 : 0) === ref[p]) ok++;
      return ok / ref.length;
    };
    const sdxl = match(0, SDXL_BITS), sd1 = match(1, SD1_BITS);
    const best = sdxl >= sd1 ? { name: 'SDXL', score: sdxl } : { name: 'Stable Diffusion v1/v2', score: sd1 };
    return { checked: true, sdxl, sd1, best, detected: best.score >= 0.85, blocks: num };
  }

  /* ---------------------------------------------------------
     3. Kompresi JPEG ganda
     DCT 8×8 dari piksel hasil decode → dibagi tabel kuantisasi file (Q2).
     Kompresi tunggal menghasilkan histogram halus (Laplace); kompresi
     ganda dengan Q1 ≠ Q2 menghasilkan pola periodik (puncak/lembah).
     --------------------------------------------------------- */
  const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
  const DCT_COS = (() => {
    const t = new Float64Array(64);
    for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) t[u * 8 + x] = Math.cos((2 * x + 1) * u * Math.PI / 16) * (u ? Math.sqrt(2 / 8) : Math.sqrt(1 / 8));
    return t;
  })();
  const HR = 40; // rentang histogram −HR…HR

  function doubleJpeg(img, meta) {
    if (meta.format !== 'JPEG' || !meta.dqt[0] || meta.dqt[0].length !== 64) return null;
    const qn = new Array(64);
    meta.dqt[0].forEach((q, k) => { qn[ZIGZAG[k]] = q; });
    const w = Math.min(1024, img.naturalWidth) & ~7, h = Math.min(1024, img.naturalHeight) & ~7;
    if (w < 64 || h < 64) return null;
    const d = canvasOf(img, 0, 0, w, h).data; // dari pojok kiri atas: kisi 8×8 tetap sejajar
    const Y = new Float64Array(w * h);
    for (let i = 0, j = 0; j < Y.length; i += 4, j++) Y[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - 128;

    const POS = ZIGZAG.slice(1, 10); // 9 koefisien AC frekuensi rendah
    const hists = POS.map(() => new Float64Array(2 * HR + 1));
    const blk = new Float64Array(64), tmp = new Float64Array(64);
    for (let by = 0; by < h; by += 8) {
      for (let bx = 0; bx < w; bx += 8) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = Y[(by + y) * w + bx + x];
        // DCT baris
        for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
          let s = 0; for (let x = 0; x < 8; x++) s += DCT_COS[u * 8 + x] * blk[y * 8 + x];
          tmp[y * 8 + u] = s;
        }
        POS.forEach((p, pi) => {
          const v = p >> 3, u = p & 7;
          let s = 0; for (let y = 0; y < 8; y++) s += DCT_COS[v * 8 + y] * tmp[y * 8 + u];
          const k = Math.round(s / qn[p]);
          if (k >= -HR && k <= HR) hists[pi][k + HR]++;
        });
      }
    }

    // Kekasaran (periodisitas) histogram |k|, k ≥ 1
    let wsum = 0, rsum = 0, used = 0;
    const perPos = [];
    hists.forEach((hst, pi) => {
      const f = new Float64Array(HR + 1);
      for (let k = 0; k <= HR; k++) f[k] = k ? hst[HR + k] + hst[HR - k] : hst[HR];
      let K = 0;
      for (let k = 1; k < HR; k++) if (f[k] >= 15) K = k;
      if (K < 4 || qn[POS[pi]] > 12) { perPos.push(null); return; }
      // osilasi: seberapa dalam lembah / tinggi puncak lokal dibanding kedua tetangga.
      // Kurva Laplace/Gauss yang menurun monoton bernilai 0, berapa pun curamnya.
      let num = 0, den = 0;
      for (let k = 1; k < K; k++) {
        const lo = Math.min(f[k - 1], f[k + 1]), hi = Math.max(f[k - 1], f[k + 1]);
        num += Math.max(0, lo - f[k]) + Math.max(0, f[k] - hi);
        den += f[k];
      }
      const r = den ? num / den : 0;
      perPos.push(r);
      rsum += r * den; wsum += den; used++;
    });
    const roughness = wsum ? rsum / wsum : 0;
    let level = 'na';
    // dikalibrasi: kompresi tunggal ≤ ~0.2, kompresi ganda (Q1 lebih rendah dari Q2) ≥ ~0.5
    if (used >= 2) level = roughness > 0.4 ? 'strong' : roughness > 0.27 ? 'weak' : 'none';
    return { roughness, level, used, hist: Array.from(hists[0]), histPos: '(0,1)', q: qn[1] };
  }

  /* ---------- 4. Histogram warna ---------- */
  function histogram(work) {
    const px = work.data.data;
    const R = new Float64Array(256), G = new Float64Array(256), Bc = new Float64Array(256), L = new Float64Array(256);
    for (let i = 0; i < px.length; i += 4) {
      R[px[i]]++; G[px[i + 1]]++; Bc[px[i + 2]]++;
      L[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])]++;
    }
    const n = px.length / 4;
    // statistik celah: bin kosong di antara bin terisi (indikasi manipulasi kontras/level)
    let gaps = 0, lo = 255, hi = 0;
    for (let v = 0; v < 256; v++) if (L[v]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let v = lo; v <= hi; v++) if (!L[v]) gaps++;
    const clipLo = L[0] / n, clipHi = L[255] / n;
    return { R: [...R].map(v => v / n), G: [...G].map(v => v / n), B: [...Bc].map(v => v / n), L: [...L].map(v => v / n), gaps, range: [lo, hi], clipLo, clipHi };
  }

  return { cfa, watermark, doubleJpeg, histogram, SDXL_BITS, SD1_BITS };
})();
