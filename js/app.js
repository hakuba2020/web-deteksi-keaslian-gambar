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

      await step('Menyusun kesimpulan…');
      S.result = Scoring.evaluate({
        meta: S.meta, width: img ? img.naturalWidth : 0, height: img ? img.naturalHeight : 0, noise, fft, ela
      });
      S.stats = { ela, noise, fft };
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
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
