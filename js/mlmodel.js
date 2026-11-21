/* =========================================================
   Detektor model AI (machine learning) — berjalan di browser
   Model : Thermostatic/community-forensics-frontier-detector-2026-08 (MIT)
           ViT-Small/16 @384, bobot FP16, input/output FP32, 1 logit mentah
   Runtime: onnxruntime-web (WASM). Gambar tidak pernah meninggalkan browser;
           hanya file model yang diunduh (sekali, lalu disimpan di cache).
   ========================================================= */
window.MLDetector = (function () {
  'use strict';

  const ORT_VER = '1.30.0';
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
  const MODEL_ID = 'Thermostatic/community-forensics-frontier-detector-2026-08';
  const MODEL_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/community_forensics_frontier_fp16.onnx`;
  const MODEL_SIZE = 43778110;
  const CACHE_NAME = 'forensik-ai-models-v1';

  // calibrator.json: p = sigmoid(logit + intercept); ambang AI: logit ≥ 1.359375 (p ≥ 0.65)
  const RAW_BOUNDARY = 1.359375;
  const INTERCEPT = -0.7403357915937764;

  // preprocessing (config.json)
  const SHORT_EDGE = 440, SIZE = 384;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  let session = null, loading = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('Gagal memuat runtime ONNX'));
      document.head.appendChild(s);
    });
  }

  async function isCached() {
    try { return !!(await (await caches.open(CACHE_NAME)).match(MODEL_URL)); } catch (e) { return false; }
  }

  async function fetchModel(onProgress) {
    try {
      const hit = await (await caches.open(CACHE_NAME)).match(MODEL_URL);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch (e) { /* cache tidak tersedia */ }

    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('Gagal mengunduh model (HTTP ' + res.status + ')');
    const total = +res.headers.get('content-length') || MODEL_SIZE;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress({ stage: 'download', loaded: got, total });
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    try { await (await caches.open(CACHE_NAME)).put(MODEL_URL, new Response(buf)); } catch (e) { /* abaikan */ }
    return buf;
  }

  async function load(onProgress) {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      onProgress({ stage: 'runtime' });
      if (!window.ort) await loadScript(ORT_BASE + 'ort.min.js');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const bytes = await fetchModel(onProgress);
      onProgress({ stage: 'init' });
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return session;
    })();
    try { return await loading; } catch (e) { loading = null; throw e; }
  }

  /* resize sisi pendek → 440, potong tengah 384×384, normalisasi ImageNet, NCHW */
  function preprocess(img, flip) {
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = SHORT_EDGE / Math.min(w, h);
    const dw = w * s, dh = h * s;
    if (flip) { x.translate(SIZE, 0); x.scale(-1, 1); }
    x.drawImage(img, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
    const d = x.getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE, out = new Float32Array(3 * plane);
    for (let i = 0, j = 0; j < plane; i += 4, j++) {
      out[j] = (d[i] / 255 - MEAN[0]) / STD[0];
      out[plane + j] = (d[i + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + j] = (d[i + 2] / 255 - MEAN[2]) / STD[2];
    }
    return out;
  }

  const sigmoid = z => 1 / (1 + Math.exp(-z));

  // sesi WASM tidak boleh dijalankan paralel → antrean
  let queue = Promise.resolve();
  function predict(img, onProgress) {
    const job = queue.then(() => predictNow(img, onProgress));
    queue = job.catch(() => {});
    return job;
  }

  async function predictNow(img, onProgress) {
    const s = await load(onProgress || (() => {}));
    (onProgress || (() => {}))({ stage: 'infer' });
    const logits = [];
    for (const flip of [false, true]) { // TTA: asli + cermin horizontal
      const t = new ort.Tensor('float32', preprocess(img, flip), [1, 3, SIZE, SIZE]);
      const out = await s.run({ [s.inputNames[0]]: t });
      logits.push(Number(out[s.outputNames[0]].data[0]));
    }
    const raw = logits.reduce((a, b) => a + b, 0) / logits.length;
    const prob = sigmoid(raw + INTERCEPT);
    return {
      raw, prob, logits,
      ai: raw >= RAW_BOUNDARY,
      margin: raw - RAW_BOUNDARY,
      lowRes: Math.min(img.naturalWidth, img.naturalHeight) < 256,
      model: MODEL_ID
    };
  }

  return { predict, isCached, MODEL_SIZE, MODEL_ID, RAW_BOUNDARY };
})();
