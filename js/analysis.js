/* =========================================================
   Analisis piksel: ELA, noise residual, spektrum FFT
   ========================================================= */
window.Analysis = (function () {
  'use strict';

  const MAX_PIXELS = 12e6; // batas resolusi kerja (12 MP)

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

  /* Kanvas kerja pada resolusi asli (diperkecil hanya bila > 12 MP) */
  function workCanvas(img) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const s = Math.min(1, Math.sqrt(MAX_PIXELS / (w0 * h0)));
    const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.drawImage(img, 0, 0, w, h);
    return { canvas: c, scale: s, data: x.getImageData(0, 0, w, h) };
  }

  /* ---------- Error Level Analysis ---------- */
  async function ela(work, quality, amp) {
    const { canvas, data } = work;
    const w = canvas.width, h = canvas.height;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    const bmp = await createImageBitmap(blob);
    const c2 = makeCanvas(w, h);
    const x2 = ctx2d(c2);
    x2.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const b = x2.getImageData(0, 0, w, h).data;
    const a = data.data;
    const out = x2.createImageData(w, h);
    const o = out.data;
    let sum = 0, max = 0;
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
      o[i] = Math.min(255, dr * amp);
      o[i + 1] = Math.min(255, dg * amp);
      o[i + 2] = Math.min(255, db * amp);
      o[i + 3] = 255;
      const m = (dr + dg + db) / 3;
      sum += m; if (m > max) max = m;
    }
    x2.putImageData(out, 0, 0);
    return { canvas: c2, mean: sum / (w * h), max };
  }

  /* ---------- Noise residual (high-pass) ---------- */
  function noise(work) {
    const { data } = work;
    const w = data.width, h = data.height, px = data.data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

    // residual = piksel - rata-rata 3x3 (via integral image)
    const W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
    }
    const r = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        const s = I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
        r[y * w + x] = g[y * w + x] - s / ((y1 - y0 + 1) * (x1 - x0 + 1));
      }
    }

    // statistik per blok 16x16
    const B = 16, stds = [];
    for (let by = 0; by + B <= h; by += B) {
      for (let bx = 0; bx + B <= w; bx += B) {
        let s = 0, s2 = 0, gm = 0;
        for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
          const v = r[y * w + x]; s += v; s2 += v * v; gm += g[y * w + x];
        }
        const n = B * B; gm /= n;
        if (gm < 10 || gm > 245) continue; // lewati area terbakar / hitam pekat
        const mu = s / n;
        stds.push(Math.sqrt(Math.max(0, s2 / n - mu * mu)));
      }
    }
    stds.sort((a, b) => a - b);
    const pct = p => stds.length ? stds[Math.min(stds.length - 1, Math.floor(p * stds.length))] : 0;
    const floor = pct(0.10), median = pct(0.5);
    const smoothFrac = stds.length ? stds.filter(v => v < 0.5).length / stds.length : 0;

    // visualisasi
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    const out = x.createImageData(w, h);
    const o = out.data;
    const amp = 14;
    for (let j = 0, i = 0; j < r.length; j++, i += 4) {
      const v = Math.min(255, Math.abs(r[j]) * amp);
      o[i] = v * 0.55; o[i + 1] = v; o[i + 2] = v * 0.95; o[i + 3] = 255;
    }
    x.putImageData(out, 0, 0);
    return { canvas: c, floor, median, smoothFrac, blocks: stds.length };
  }

  /* ---------- FFT ---------- */
  function fft1d(re, im, n, rev, cos, sin) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const tr = cos[k * step], ti = -sin[k * step];
          const a = i + k, b = a + half;
          const xr = re[b] * tr - im[b] * ti, xi = re[b] * ti + im[b] * tr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  function fft(img, format) {
    const minSide = Math.min(img.naturalWidth, img.naturalHeight);
    let N = 512;
    while (N > minSide && N > 64) N >>= 1;
    if (N > minSide) return null;

    // potongan tengah pada resolusi asli (tanpa scaling, agar artefak tetap utuh)
    const c = makeCanvas(N, N);
    const x = ctx2d(c);
    const sx = Math.floor((img.naturalWidth - N) / 2), sy = Math.floor((img.naturalHeight - N) / 2);
    x.drawImage(img, sx, sy, N, N, 0, 0, N, N);
    const px = x.getImageData(0, 0, N, N).data;

    const re = new Float64Array(N * N), im = new Float64Array(N * N);
    let mean = 0;
    for (let j = 0, i = 0; j < N * N; j++, i += 4) { re[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; mean += re[j]; }
    mean /= N * N;
    const hann = new Float64Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) re[y * N + xx] = (re[y * N + xx] - mean) * hann[y] * hann[xx];

    const bits = Math.log2(N);
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / N); sin[k] = Math.sin(2 * Math.PI * k / N); }

    const tr = new Float64Array(N), ti = new Float64Array(N);
    for (let y = 0; y < N; y++) { // baris
      for (let k = 0; k < N; k++) { tr[k] = re[y * N + k]; ti[k] = im[y * N + k]; }
      fft1d(tr, ti, N, rev, cos, sin);
      for (let k = 0; k < N; k++) { re[y * N + k] = tr[k]; im[y * N + k] = ti[k]; }
    }
    for (let xx = 0; xx < N; xx++) { // kolom
      for (let k = 0; k < N; k++) { tr[k] = re[k * N + xx]; ti[k] = im[k * N + xx]; }
      fft1d(tr, ti, N, rev, cos, sin);
      for (let k = 0; k < N; k++) { re[k * N + xx] = tr[k]; im[k * N + xx] = ti[k]; }
    }

    // log-magnitude, digeser agar DC di tengah
    const H = N / 2;
    const mag = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
      const j = y * N + xx;
      const sy2 = (y + H) % N, sx2 = (xx + H) % N;
      mag[sy2 * N + sx2] = Math.log1p(Math.hypot(re[j], im[j]));
    }

    // profil radial (rata-rata & simpangan baku per radius)
    const R = Math.ceil(Math.SQRT2 * H) + 1;
    const rs = new Float64Array(R), rs2 = new Float64Array(R), rn = new Float64Array(R);
    for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
      const r = Math.round(Math.hypot(xx - H, y - H));
      const v = mag[y * N + xx]; rs[r] += v; rs2[r] += v * v; rn[r]++;
    }
    const rm = new Float64Array(R), rsd = new Float64Array(R);
    for (let r = 0; r < R; r++) if (rn[r]) { rm[r] = rs[r] / rn[r]; rsd[r] = Math.sqrt(Math.max(1e-6, rs2[r] / rn[r] - rm[r] * rm[r])); }

    // deteksi puncak periodik
    const grid = N / 8, minR = N / 32;
    const peaks = [];
    for (let y = 1; y < N - 1; y++) for (let xx = 1; xx < N - 1; xx++) {
      const dx = xx - H, dy = y - H;
      if (Math.abs(dx) <= 2 || Math.abs(dy) <= 2) continue; // sumbu (efek tepi)
      const r = Math.round(Math.hypot(dx, dy));
      if (r < minR || r >= H) continue;
      const v = mag[y * N + xx];
      const z = (v - rm[r]) / rsd[r];
      if (z < 6 || v - rm[r] < 2.2) continue;
      let isMax = true;
      for (let k = -1; k <= 1 && isMax; k++) for (let l = -1; l <= 1; l++) {
        if ((k || l) && mag[(y + k) * N + xx + l] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      if (format === 'JPEG') { // abaikan grid blok 8x8 JPEG
        const mx = ((dx % grid) + grid) % grid, my = ((dy % grid) + grid) % grid;
        const nearX = mx <= 1 || mx >= grid - 1, nearY = my <= 1 || my >= grid - 1;
        if (nearX && nearY) continue;
      }
      peaks.push({ x: xx, y, z });
    }

    // visualisasi (colormap)
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < mag.length; j++) {
      const v = mag[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = lo + (hi - lo) * 0.25; hi = hi - (hi - lo) * 0.05;
    const out = x.createImageData(N, N);
    const o = out.data;
    for (let j = 0, i = 0; j < mag.length; j++, i += 4) {
      const t = Math.max(0, Math.min(1, (mag[j] - lo) / (hi - lo)));
      const [rr, gg, bb] = colormap(t);
      o[i] = rr; o[i + 1] = gg; o[i + 2] = bb; o[i + 3] = 255;
    }
    x.putImageData(out, 0, 0);
    x.strokeStyle = 'rgba(57,208,196,.95)';
    x.lineWidth = 1.5;
    for (const p of peaks.slice(0, 60)) { x.beginPath(); x.arc(p.x, p.y, 6, 0, Math.PI * 2); x.stroke(); }

    return { canvas: c, N, peaks: peaks.length, peakPairs: Math.ceil(peaks.length / 2), radial: Array.from(rm.slice(1, H)) };
  }

  const CMAP = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  function colormap(t) {
    const p = t * (CMAP.length - 1), i = Math.min(CMAP.length - 2, Math.floor(p)), f = p - i;
    const a = CMAP[i], b = CMAP[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  return { workCanvas, ela, noise, fft };
})();
