/* =========================================================
   UI & orkestrasi
   ========================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const drop = $('#dropzone'), input = $('#fileInput');
  const S = { file: null, img: null, work: null, meta: null, views: {}, result: null, hash: null, url: null, view: 'original' };

  const HELP = {
    original: 'Gambar asli. Perhatikan detail yang sering keliru pada gambar AI: jari tangan, gigi, telinga, teks/huruf, pantulan, bayangan, dan pola latar yang tidak konsisten.',
    ela: 'Error Level Analysis: area yang jauh lebih terang/berbeda dari sekitarnya dapat menandakan bagian yang ditempel atau diedit. Gambar AI utuh biasanya menunjukkan error yang seragam.',
    noise: 'Residu noise (high-pass). Foto kamera menampilkan butiran noise halus di seluruh bidang; area hitam pekat yang luas pada bidang datar menandakan permukaan “terlalu bersih” khas gambar sintetis.',
    fft: 'Spektrum frekuensi (log-magnitude) dari potongan tengah. Lingkaran menandai puncak periodik terdeteksi. Pola titik berulang/simetris dapat berasal dari upsampling model AI.'
  };

  /* ---------- input ---------- */
  $('#pickBtn').addEventListener('click', e => { e.stopPropagation(); input.click(); });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { if (input.files[0]) handle(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === drop) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) handle(f); });
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
    if (item) handle(item.getAsFile());
  });
  $('#newBtn').addEventListener('click', reset);
  $('#reportBtn').addEventListener('click', downloadReport);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

  let elaTimer;
  ['#elaQ', '#elaA'].forEach(id => $(id).addEventListener('input', () => {
    $('#elaQOut').textContent = $('#elaQ').value;
    $('#elaAOut').textContent = $('#elaA').value + '×';
    clearTimeout(elaTimer);
    elaTimer = setTimeout(async () => {
      if (!S.work) return;
      S.views.ela = (await Analysis.ela(S.work, $('#elaQ').value / 100, +$('#elaA').value)).canvas;
      if (S.view === 'ela') setView('ela');
    }, 180);
  }));

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const step = async txt => { $('#loadingText').textContent = txt; await new Promise(r => setTimeout(r, 30)); };

  function reset() {
    if (S.url) URL.revokeObjectURL(S.url);
    Object.assign(S, { file: null, img: null, work: null, meta: null, views: {}, result: null, hash: null, url: null });
    $('#results').hidden = true; drop.hidden = false; $('#howto').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function loadImage(url) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  }

  async function sha256(bytes) {
    try {
      const h = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }

  /* ---------- pipeline ---------- */
  async function handle(file) {
    if (!file) return;
    if (!(file.type || '').startsWith('image/') && !/\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(file.name || '')) {
      toast('File yang dipilih bukan gambar.'); return;
    }
    if (S.url) URL.revokeObjectURL(S.url);
    drop.hidden = true; $('#howto').hidden = true; $('#results').hidden = true; $('#loading').hidden = false;
    try {
      S.file = file; S.views = {};
      await step('Membaca file…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      await step('Memeriksa metadata & tanda tangan AI…');
      S.meta = await Meta.parse(bytes);
      S.hash = await sha256(bytes);

      S.url = URL.createObjectURL(file);
      let img = null;
      try { img = await loadImage(S.url); } catch (e) { img = null; }
      S.img = img;

      let ela = null, noise = null, fft = null;
      if (img) {
        S.views.original = img;
        await step('Menyiapkan kanvas kerja…');
        S.work = Analysis.workCanvas(img);
        await step('Error Level Analysis…');
        ela = await Analysis.ela(S.work, $('#elaQ').value / 100, +$('#elaA').value);
        S.views.ela = ela.canvas;
        await step('Mengekstrak residu noise sensor…');
        noise = Analysis.noise(S.work);
        S.views.noise = noise.canvas;
        await step('Menghitung spektrum Fourier (FFT)…');
        fft = Analysis.fft(img, S.meta.format);
        if (fft) S.views.fft = fft.canvas;
      }

      const sig = {};
      if (img) {
        await step('Mendeteksi jejak sensor kamera (CFA)…');
        sig.cfa = Signal.cfa(img);
        await step('Mendekode watermark tak terlihat…');
        sig.wm = Signal.watermark(img, S.work);
        await step('Menganalisis kompresi JPEG ganda…');
        sig.dj = Signal.doubleJpeg(img, S.meta);
        sig.hist = Signal.histogram(S.work);
      }

      await step('Menyusun kesimpulan…');
      S.result = Scoring.evaluate({
        meta: S.meta, width: img ? img.naturalWidth : 0, height: img ? img.naturalHeight : 0, noise, fft, ela, sig
      });
      S.stats = { ela, noise, fft, sig };
      render();
    } catch (err) {
      console.error(err);
      toast('Gagal menganalisis: ' + err.message);
      reset();
    } finally {
      $('#loading').hidden = true;
    }
  }

  /* ---------- render ---------- */
  function setView(v) {
    S.view = v;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
    const stage = $('#stage');
    stage.replaceChildren();
    const node = S.views[v];
    if (node) stage.appendChild(node);
    else stage.appendChild(el('div', 'na', v === 'original'
      ? 'Browser tidak dapat menampilkan format ini (mis. HEIC). Analisis metadata tetap dijalankan.'
      : 'Analisis ini tidak tersedia untuk gambar ini (format tidak didukung atau gambar terlalu kecil).'));
    $('#elaControls').hidden = v !== 'ela';
    $('#viewHelp').textContent = HELP[v];
  }

  function render() {
    const r = S.result, m = S.meta, img = S.img;
    $('#results').hidden = false;
    setView('original');

    // verdict
    const vp = $('#verdictPanel');
    vp.classList.remove('ai', 'warn', 'real'); vp.classList.add(r.level);
    const pct = Math.round(r.p * 100);
    $('#gaugeNum').textContent = pct + '%';
    const fill = $('#gaugeFill');
    fill.style.stroke = r.level === 'ai' ? 'var(--ai)' : r.level === 'warn' ? 'var(--warn)' : 'var(--real)';
    fill.style.strokeDashoffset = 314.16;
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.strokeDashoffset = 314.16 * (1 - r.p); }));
    $('#verdictLabel').textContent = r.label;
    $('#verdictTitle').textContent = r.title;
    $('#verdictDesc').textContent = r.desc;

    // indicators
    const list = $('#indicators'); list.replaceChildren();
    const TAG = { ai: 'Mengarah AI', real: 'Mengarah asli', info: 'Info' };
    const order = { ai: 0, real: 1, info: 2 };
    r.indicators.slice().sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(b.w) - Math.abs(a.w)).forEach(i => {
      const li = el('li', 'ind ' + i.kind);
      const head = el('div', 'ind-head');
      head.append(el('b', null, i.title), el('span', 'tag', TAG[i.kind]));
      li.append(head, el('p', null, i.detail));
      list.appendChild(li);
    });

    // file info
    const fi = $('#fileInfo'); fi.replaceChildren();
    const rows = [
      ['Nama file', S.file.name || '(dari clipboard)'],
      ['Ukuran', fmtBytes(S.file.size)],
      ['Format (magic bytes)', m.format + (S.file.type ? ` · ${S.file.type}` : '')],
      ['Dimensi', img ? `${img.naturalWidth} × ${img.naturalHeight} px (${(img.naturalWidth * img.naturalHeight / 1e6).toFixed(2)} MP)` : '—'],
      ['Kualitas JPEG (est.)', m.jpegQuality ? '≈ ' + m.jpegQuality + (m.progressive ? ' · progresif' : '') : '—'],
      ['Profil warna ICC', m.icc ? 'Ada' : 'Tidak ada'],
      ['Content Credentials', m.c2pa ? 'Ada (C2PA)' : 'Tidak ada'],
      ['Terakhir diubah', S.file.lastModified ? new Date(S.file.lastModified).toLocaleString('id-ID') : '—'],
      ['SHA-256', S.hash || 'tidak tersedia'],
    ];
    rows.forEach(([k, v]) => fi.appendChild(row(k, v)));

    renderMeta();
    renderSignal();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- analisis sinyal ---------- */
  function sigCard(name, cls, tag, value, meter, text) {
    const c = el('div', 'sig ' + cls);
    const top = el('div', 'sig-top');
    top.append(el('b', null, name), el('span', 'tag', tag));
    c.append(top, el('div', 'sig-val', value));
    if (meter != null) {
      const m = el('div', 'meter'), s = el('span');
      s.style.width = Math.round(Math.max(0, Math.min(1, meter)) * 100) + '%';
      m.appendChild(s); c.appendChild(m);
    }
    c.appendChild(el('p', null, text));
    return c;
  }

  function renderSignal() {
    const st = S.stats || {}, sig = st.sig || {};
    const box = $('#sigCards');
    box.replaceChildren();
    const panel = box.closest('.signal-panel');
    panel.hidden = !S.img;
    if (!S.img) return;

    // CFA
    const c = sig.cfa;
    if (!c || c.level === 'na') {
      box.appendChild(sigCard('Jejak sensor (CFA)', 'info', 'Tidak cukup data', '—', null,
        'Gambar terlalu kecil atau terlalu datar untuk mengukur pola demosaicing.'));
    } else {
      const map = {
        strong: ['real', 'Terdeteksi', 'Pola interpolasi Bayer kuat & konsisten — ciri khas foto dari sensor kamera digital.'],
        weak: ['real', 'Lemah', 'Ada sisa pola Bayer. Konsisten dengan foto kamera yang telah dikompresi/diproses.'],
        none: ['warn', 'Tidak ada', 'Tidak ada pola demosaicing. Wajar untuk gambar AI, tetapi juga untuk foto yang diperkecil, dipotong ganjil, atau dikompresi berat.']
      }[c.level];
      box.appendChild(sigCard('Jejak sensor (CFA)', map[0], map[1],
        `rasio ${c.ratio.toFixed(2)}× · ${Math.round(c.consistency * 100)}%`, Math.min(1, (c.ratio - 1) / 0.4),
        map[2] + ` (${c.blocks} blok dianalisis, fase ${c.phase}).`));
    }

    // Watermark
    const w = sig.wm;
    if (!w || !w.checked) {
      box.appendChild(sigCard('Watermark tak terlihat', 'info', 'Dilewati', '—', null, (w && w.reason) || 'Tidak dapat diperiksa.'));
    } else if (w.detected) {
      box.appendChild(sigCard('Watermark tak terlihat', 'ai', 'Terdeteksi', `${w.best.name} · ${Math.round(w.best.score * 100)}%`, w.best.score,
        `Pesan watermark ${w.best.name} terbaca ${Math.round(w.best.score * 100)}% cocok. Ini bukti kuat bahwa gambar adalah keluaran asli Stable Diffusion.`));
    } else {
      box.appendChild(sigCard('Watermark tak terlihat', 'info', 'Tidak ditemukan', `SDXL ${Math.round(w.sdxl * 100)}% · SD1 ${Math.round(w.sd1 * 100)}%`, Math.max(w.sdxl, w.sd1),
        'Kecocokan bit di tingkat acak (≈50%). Watermark ini mudah hilang bila gambar diubah ukuran, dipotong, atau dikompresi; banyak generator lain tidak memakainya.'));
    }

    // JPEG ganda
    const d = sig.dj;
    if (!d) {
      box.appendChild(sigCard('Kompresi JPEG ganda', 'info', 'Tidak berlaku', '—', null, 'Hanya untuk file JPEG dengan tabel kuantisasi yang terbaca.'));
    } else if (d.level === 'na') {
      box.appendChild(sigCard('Kompresi JPEG ganda', 'info', 'Tidak konklusif', d.roughness.toFixed(2), null, 'Kualitas JPEG terlalu rendah atau gambar terlalu datar untuk membentuk histogram yang dapat diuji.'));
    } else {
      const map = {
        strong: ['warn', 'Terdeteksi', 'Histogram DCT bergerigi periodik — JPEG ini hampir pasti pernah disimpan ulang (diedit, di-screenshot ulang, atau diunggah ulang).'],
        weak: ['warn', 'Mungkin', 'Ada sedikit periodisitas di histogram DCT; kemungkinan pernah dikompresi ulang.'],
        none: ['real', 'Tunggal', 'Histogram DCT halus — konsisten dengan satu kali kompresi JPEG.']
      }[d.level];
      box.appendChild(sigCard('Kompresi JPEG ganda', map[0], map[1], 'kekasaran ' + d.roughness.toFixed(2), Math.min(1, d.roughness / 0.9), map[2]));
    }

    // Grafik
    const h = sig.hist;
    if (h) {
      const pct = (v, tip) => (v * 100).toFixed(tip ? 3 : 1) + '%';
      Charts.draw($('#chHist'), {
        type: 'line', height: 170,
        series: [
          { name: 'Merah', color: '#ff6b6b', values: h.R },
          { name: 'Hijau', color: '#4ade80', values: h.G },
          { name: 'Biru', color: '#60a5fa', values: h.B },
          { name: 'Luminans', color: '#cbd5e1', values: h.L }
        ],
        x: i => 'Nilai ' + i, tick: i => String(i), xTicks: [0, 64, 128, 192, 255], yFmt: pct, xTitle: 'intensitas (0–255)'
      });
    }
    if (st.fft && st.fft.radial) {
      const r = st.fft.radial, n = r.length;
      Charts.draw($('#chRadial'), {
        type: 'line', height: 170, fill: true,
        series: [{ name: 'Energi log', color: '#39d0c4', values: r }],
        yMin: Math.floor(Math.min(...r)),
        x: i => 'f = ' + ((i + 1) / (n + 1)).toFixed(2), tick: i => ((i + 1) / (n + 1)).toFixed(2), xTicks: [0, Math.round(n / 4), Math.round(n / 2), Math.round(3 * n / 4), n - 1],
        yFmt: v => v.toFixed(1), xTitle: 'frekuensi ternormalisasi (rendah → tinggi)'
      });
    } else $('#chRadial').replaceChildren(el('p', 'empty', 'Tidak tersedia.'));

    $('#dctBox').hidden = !d;
    if (d) {
      const HR = (d.hist.length - 1) / 2, lim = 20;
      const vals = d.hist.slice(HR - lim, HR + lim + 1);
      const tot = d.hist.reduce((a, b) => a + b, 0) || 1;
      Charts.draw($('#chDct'), {
        type: 'bar', height: 170,
        series: [{ name: 'Blok', color: '#7aa7ff', values: vals.map(v => v / tot) }],
        yMax: Math.min(1, Math.max(...vals) / tot * 1.08) || 1,
        x: i => 'k = ' + (i - lim), tick: i => String(i - lim), xTicks: [0, lim / 2, lim, lim * 1.5, 2 * lim],
        yFmt: (v, tip) => (v * 100).toFixed(tip ? 2 : 0) + '%', xTitle: `koefisien / Q (Q = ${d.q})`
      });
    }
  }

  function row(k, v) {
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, String(v)));
    return tr;
  }

  function renderMeta() {
    const m = S.meta, box = $('#metaBox');
    box.replaceChildren();

    // EXIF
    const exSec = el('div', 'meta-section');
    exSec.appendChild(el('h4', null, 'EXIF'));
    const ex = m.exif, keys = Object.keys(ex);
    if (keys.length) {
      const t = el('table', 'kv');
      const LABEL = {
        Make: 'Merek', Model: 'Model', Software: 'Perangkat lunak', DateTimeOriginal: 'Waktu pengambilan',
        DateTime: 'Waktu ubah', ExposureTime: 'Kecepatan rana', FNumber: 'Aperture', ISO: 'ISO',
        FocalLength: 'Focal length', LensModel: 'Lensa', LensMake: 'Merek lensa', GPS: 'GPS',
        Artist: 'Pembuat', Copyright: 'Hak cipta', ImageDescription: 'Deskripsi', UserComment: 'Komentar',
        Orientation: 'Orientasi', Flash: 'Flash', PixelXDimension: 'Lebar EXIF', PixelYDimension: 'Tinggi EXIF',
        DateTimeDigitized: 'Waktu digitasi', ImageUniqueID: 'ID unik', BodySerialNumber: 'No. seri bodi'
      };
      keys.forEach(k => {
        let v = ex[k];
        if (k === 'ExposureTime') v = Scoring.fmtExposure(v);
        else if (k === 'FNumber') v = 'f/' + (+v).toFixed(1);
        else if (k === 'FocalLength') v = (+v).toFixed(1) + ' mm';
        else if (k === 'GPS') v = 'Ada data lokasi';
        else if (typeof v === 'number' && !Number.isInteger(v)) v = v.toFixed(3);
        if (typeof v === 'string' && v.length > 300) v = v.slice(0, 300) + '…';
        t.appendChild(row(LABEL[k] || k, v));
      });
      exSec.appendChild(t);
    } else exSec.appendChild(el('p', 'empty', 'Tidak ada data EXIF.'));
    box.appendChild(exSec);

    // PNG text chunks / comments
    if (m.text.length || m.comments.length) {
      const sec = el('div', 'meta-section');
      sec.appendChild(el('h4', null, m.text.length ? 'Teks tertanam (PNG chunk)' : 'Komentar JPEG'));
      [...m.text, ...m.comments.map(c => ({ key: 'Comment', value: c }))].forEach(t => sec.appendChild(details(`${t.key} (${t.value.length} karakter)`, prettify(t.value))));
      box.appendChild(sec);
    }

    // XMP
    if (m.xmp.trim()) {
      const sec = el('div', 'meta-section');
      sec.appendChild(el('h4', null, 'XMP'));
      sec.appendChild(details(`Paket XMP (${m.xmp.length} karakter)`, m.xmp.trim()));
      box.appendChild(sec);
    }

    // Struktur
    const sec = el('div', 'meta-section');
    sec.appendChild(el('h4', null, 'Struktur file'));
    sec.appendChild(el('p', 'small muted', m.segments.length ? [...new Set(m.segments)].join(' · ') : '—'));
    if (m.parseError) sec.appendChild(el('p', 'small muted', 'Catatan parser: ' + m.parseError));
    box.appendChild(sec);
  }

  function details(summary, text) {
    const d = el('details');
    d.append(el('summary', null, summary), el('pre', null, text.length > 60000 ? text.slice(0, 60000) + '\n…(dipotong)' : text));
    return d;
  }
  function prettify(v) {
    const s = v.trim();
    if (s[0] === '{' || s[0] === '[') { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { /* biarkan */ } }
    return v;
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* ---------- laporan ---------- */
  function downloadReport() {
    const r = S.result, m = S.meta, img = S.img, st = S.stats || {};
    const L = [];
    const line = '='.repeat(64);
    L.push(line, 'LAPORAN FORENSIK GAMBAR — FORENSIK·AI', line);
    L.push('Dibuat           : ' + new Date().toLocaleString('id-ID'));
    L.push('Nama file        : ' + (S.file.name || '(clipboard)'));
    L.push('Ukuran           : ' + fmtBytes(S.file.size) + ` (${S.file.size} byte)`);
    L.push('Format           : ' + m.format);
    L.push('Dimensi          : ' + (img ? `${img.naturalWidth} x ${img.naturalHeight}` : '-'));
    L.push('SHA-256          : ' + (S.hash || '-'));
    L.push('');
    L.push('KESIMPULAN       : ' + r.label.toUpperCase() + ' — ' + r.title);
    L.push('Indikasi AI      : ' + Math.round(r.p * 100) + '%  (skor log-odds ' + r.L.toFixed(2) + ')');
    L.push(r.desc);
    L.push('', '-'.repeat(64), 'INDIKATOR', '-'.repeat(64));
    r.indicators.forEach((i, n) => {
      L.push(`${n + 1}. [${i.kind === 'ai' ? 'AI' : i.kind === 'real' ? 'ASLI' : 'INFO'}] ${i.title}` + (i.w ? `  (bobot ${i.w > 0 ? '+' : ''}${i.w.toFixed(2)})` : ''));
      L.push('   ' + i.detail);
    });
    L.push('', '-'.repeat(64), 'METRIK TEKNIS', '-'.repeat(64));
    if (st.ela) L.push(`ELA rata-rata    : ${st.ela.mean.toFixed(3)} (maks ${st.ela.max.toFixed(1)})`);
    if (st.noise) L.push(`Noise            : lantai ${st.noise.floor.toFixed(3)}, median ${st.noise.median.toFixed(3)}, blok halus ${(st.noise.smoothFrac * 100).toFixed(1)}%`);
    if (st.fft) L.push(`FFT              : ${st.fft.N}x${st.fft.N}, ${st.fft.peakPairs} puncak periodik`);
    const sg = st.sig || {};
    if (sg.cfa && sg.cfa.level !== 'na') L.push(`CFA (sensor)     : ${sg.cfa.level}, rasio ${sg.cfa.ratio.toFixed(3)}, konsistensi ${(sg.cfa.consistency * 100).toFixed(0)}%`);
    if (sg.wm) L.push(sg.wm.checked ? `Watermark SD     : ${sg.wm.detected ? 'TERDETEKSI (' + sg.wm.best.name + ')' : 'tidak ditemukan'} — SDXL ${(sg.wm.sdxl * 100).toFixed(0)}%, SD1 ${(sg.wm.sd1 * 100).toFixed(0)}%` : `Watermark SD     : dilewati (${sg.wm.reason})`);
    if (sg.dj) L.push(`JPEG ganda       : ${sg.dj.level}, kekasaran histogram DCT ${sg.dj.roughness.toFixed(3)}`);
    if (sg.hist) L.push(`Histogram        : rentang ${sg.hist.range[0]}–${sg.hist.range[1]}, ${sg.hist.gaps} celah, terbakar ${(sg.hist.clipHi * 100).toFixed(2)}%`);
    if (m.jpegQuality) L.push(`Kualitas JPEG    : ~${m.jpegQuality}`);
    L.push(`C2PA             : ${m.c2pa ? 'ada' : 'tidak ada'}`);
    L.push('', '-'.repeat(64), 'EXIF', '-'.repeat(64));
    const ek = Object.keys(m.exif);
    if (ek.length) ek.forEach(k => L.push(k.padEnd(17) + ': ' + String(m.exif[k]).slice(0, 300)));
    else L.push('(tidak ada)');
    if (m.text.length) {
      L.push('', '-'.repeat(64), 'TEKS TERTANAM', '-'.repeat(64));
      m.text.forEach(t => L.push(`[${t.key}]`, t.value.slice(0, 4000), ''));
    }
    L.push('', line, 'Catatan: hasil ini merupakan indikasi forensik otomatis, bukan bukti mutlak.', line);

    const blob = new Blob([L.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'laporan-forensik-' + (S.file.name || 'gambar').replace(/\.[^.]+$/, '') + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
})();
