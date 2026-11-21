/* =========================================================
   Penggabungan bukti → skor indikasi AI (model log-odds sederhana)
   ========================================================= */
window.Scoring = (function () {
  'use strict';

  const KNOWN_AI_SIZES = new Set([
    '512x512', '768x768', '1024x1024', '1536x1536', '2048x2048', '512x768', '768x512',
    '1024x1792', '1792x1024', '1024x1536', '1536x1024', '1152x896', '896x1152',
    '1216x832', '832x1216', '1344x768', '768x1344', '1536x640', '640x1536',
    '1456x816', '816x1456', '1232x928', '928x1232', '1344x896', '896x1344',
    '2912x1632', '1632x2912', '2048x1152', '1152x2048', '1408x704', '704x1408'
  ]);

  function fmtExposure(v) {
    if (typeof v !== 'number' || !v) return null;
    return v < 1 ? '1/' + Math.round(1 / v) + ' dtk' : v + ' dtk';
  }

  function evaluate({ meta, width, height, noise, fft, ela }) {
    const ind = [];
    let L = 0;
    let confirmed = false;

    /* 1. Tanda tangan AI di metadata */
    const sigs = meta.signatures.slice().sort((a, b) => b.points - a.points);
    if (sigs.length) {
      L += sigs[0].points + Math.min(1.5, (sigs.length - 1) * 0.5);
      if (sigs[0].points >= 5) confirmed = true;
      for (const s of sigs) {
        ind.push({ kind: 'ai', w: s.points, title: s.label, detail: `Ditemukan di ${s.src}: “${s.snippet}”` });
      }
    }

    /* 2. Data kamera EXIF */
    const ex = meta.exif;
    if (ex.Make || ex.Model) {
      let c = -1.4;
      const parts = [];
      if (ex.ExposureTime) { c -= 0.4; parts.push('rana ' + fmtExposure(ex.ExposureTime)); }
      if (ex.FNumber) { c -= 0.3; parts.push('f/' + (+ex.FNumber).toFixed(1)); }
      if (ex.ISO) { c -= 0.3; parts.push('ISO ' + ex.ISO); }
      if (ex.FocalLength) parts.push((+ex.FocalLength).toFixed(1) + ' mm');
      if (ex.LensModel) { c -= 0.2; parts.push('lensa ' + ex.LensModel); }
      if (ex.GPS) { c -= 0.2; parts.push('koordinat GPS'); }
      if (sigs.length && confirmed) c = Math.max(c, -1); // kontradiksi: EXIF mungkin disalin
      L += c;
      const dev = ex.Make && ex.Model && String(ex.Model).toLowerCase().startsWith(String(ex.Make).toLowerCase())
        ? ex.Model : [ex.Make, ex.Model].filter(Boolean).join(' ');
      ind.push({
        kind: 'real', w: c, title: `Metadata kamera: ${dev}`,
        detail: (parts.length ? 'Parameter pemotretan: ' + parts.join(', ') + '. ' : '') +
          'EXIF kamera umumnya berasal dari perangkat fisik — namun dapat disalin atau dipalsukan.'
      });
    } else if (!sigs.length) {
      L += 0.4;
      ind.push({
        kind: 'ai', w: 0.4, title: 'Tidak ada metadata kamera',
        detail: 'Tidak ditemukan EXIF kamera. Umum pada gambar AI, tetapi juga pada tangkapan layar dan gambar yang diunduh dari media sosial/WhatsApp (EXIF dihapus otomatis).'
      });
    }

    /* 3. C2PA */
    if (meta.c2pa) {
      ind.push({
        kind: 'info', w: 0, title: 'Content Credentials (C2PA) ditemukan',
        detail: 'File memuat manifest asal-usul C2PA. Verifikasi tanda tangan & riwayat suntingannya di contentcredentials.org/verify.'
      });
    }

    /* 4. Perangkat lunak */
    if (meta.aiEditSoftware) {
      L += 1.2;
      ind.push({ kind: 'ai', w: 1.2, title: `Diproses aplikasi peningkatan AI: ${meta.aiEditSoftware}`, detail: 'Aplikasi ini memakai AI untuk mengubah/menyempurnakan wajah atau detail gambar.' });
    } else if (meta.editSoftware) {
      ind.push({ kind: 'info', w: 0, title: `Disunting dengan ${meta.editSoftware}`, detail: `Tag perangkat lunak: “${meta.softwareString}”. Penyuntingan tidak otomatis berarti AI, tetapi berarti gambar bukan keluaran kamera murni.` });
    }

    /* 5. Dimensi */
    const key = width + 'x' + height;
    if (KNOWN_AI_SIZES.has(key)) {
      L += 0.8;
      ind.push({ kind: 'ai', w: 0.8, title: `Resolusi khas generator AI (${width}×${height})`, detail: 'Ukuran ini merupakan keluaran bawaan umum dari Stable Diffusion, SDXL, DALL·E, Midjourney, atau GPT-image.' });
    } else if (width % 64 === 0 && height % 64 === 0 && Math.min(width, height) >= 512) {
      L += 0.35;
      ind.push({ kind: 'ai', w: 0.35, title: `Dimensi kelipatan 64 (${width}×${height})`, detail: 'Model difusi bekerja pada kelipatan 64 piksel. Indikator lemah — banyak gambar biasa juga memiliki ukuran ini.' });
    }

    /* 6. Noise sensor */
    if (noise && noise.blocks > 20) {
      const compressed = meta.format === 'JPEG' && meta.jpegQuality && meta.jpegQuality < 88;
      const f = noise.floor.toFixed(2), m = noise.median.toFixed(2);
      if (noise.floor < 0.35 && noise.smoothFrac > 0.15 && !compressed) {
        L += 0.6;
        ind.push({ kind: 'ai', w: 0.6, title: 'Area datar sangat halus tanpa noise sensor', detail: `${Math.round(noise.smoothFrac * 100)}% blok hampir tanpa noise (lantai noise ${f}, median ${m}). Kamera fisik biasanya menghasilkan butiran noise di seluruh gambar.` });
      } else if (noise.floor > 1.1) {
        L -= 0.6;
        ind.push({ kind: 'real', w: -0.6, title: 'Noise merata di seluruh gambar', detail: `Lantai noise ${f}, median ${m}. Pola ini konsisten dengan noise sensor kamera.` });
      } else {
        ind.push({ kind: 'info', w: 0, title: 'Pola noise tidak konklusif', detail: `Lantai noise ${f}, median ${m}${compressed ? '; kompresi JPEG (≈Q' + meta.jpegQuality + ') dapat menghapus noise asli' : ''}.` });
      }
    }

    /* 7. Spektrum FFT */
    if (fft) {
      if (fft.peakPairs >= 4) {
        L += 1.0;
        ind.push({ kind: 'ai', w: 1.0, title: `Pola periodik kuat di spektrum frekuensi (${fft.peakPairs} puncak)`, detail: 'Titik terang berulang di spektrum dapat berasal dari lapisan upsampling model AI. Tekstur berulang (kain, pagar, layar) juga dapat memicunya — lihat tab Spektrum FFT.' });
      } else if (fft.peakPairs >= 1) {
        L += 0.35;
        ind.push({ kind: 'ai', w: 0.35, title: `Sedikit puncak periodik di spektrum (${fft.peakPairs})`, detail: 'Ada beberapa puncak frekuensi tidak wajar. Indikator lemah.' });
      } else {
        L -= 0.2;
        ind.push({ kind: 'real', w: -0.2, title: 'Spektrum frekuensi tanpa puncak periodik', detail: `Tidak ditemukan artefak grid pada potongan ${fft.N}×${fft.N} piksel.` });
      }
    }

    /* 8. ELA (informasi) */
    if (ela) {
      ind.push({ kind: 'info', w: 0, title: `Error level rata-rata: ${ela.mean.toFixed(2)}`, detail: 'ELA berguna untuk melihat area tempelan/suntingan (lebih terang dari sekitarnya). Tidak dipakai langsung sebagai skor AI — periksa visual di tab ELA.' });
    }

    if (meta.format === 'JPEG' && meta.jpegQuality) {
      ind.push({ kind: 'info', w: 0, title: `Kualitas JPEG ≈ ${meta.jpegQuality}`, detail: meta.jpegQuality < 85 ? 'Kompresi cukup berat (mungkin hasil unggah ulang media sosial) — jejak forensik dapat berkurang.' : 'Kompresi ringan, jejak forensik relatif terjaga.' });
    }

    let p = 1 / (1 + Math.exp(-L));
    p = Math.max(0.02, Math.min(0.98, p));

    let level, label, title, desc;
    if (confirmed) {
      level = 'ai'; label = 'Terdeteksi dari metadata';
      title = 'Gambar ini dibuat / diproses AI';
      desc = 'File memuat jejak eksplisit dari generator AI. Ini bukti terkuat yang bisa diperoleh dari analisis file.';
    } else if (p >= 0.7) {
      level = 'ai'; label = 'Kemungkinan AI';
      title = 'Banyak indikasi buatan AI';
      desc = 'Beberapa indikator teknis mengarah ke gambar sintetis, meski tidak ada tanda tangan generator yang eksplisit.';
    } else if (p >= 0.42) {
      level = 'warn'; label = 'Tidak meyakinkan';
      title = 'Belum dapat dipastikan';
      desc = 'Bukti teknis lemah atau saling bertentangan. Periksa sumber gambar, lakukan pencarian gambar terbalik, dan perhatikan detail visual (tangan, teks, bayangan).';
    } else {
      level = 'real'; label = 'Kemungkinan asli';
      title = 'Cenderung foto asli';
      desc = 'Indikator yang ditemukan lebih konsisten dengan foto dari kamera. Tetap waspada: gambar AI dapat diberi EXIF palsu.';
    }

    return { L, p, confirmed, level, label, title, desc, indicators: ind };
  }

  return { evaluate, fmtExposure };
})();
