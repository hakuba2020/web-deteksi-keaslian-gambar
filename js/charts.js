/* =========================================================
   Grafik kanvas ringan (garis / batang) dengan tooltip hover
   ========================================================= */
window.Charts = (function () {
  'use strict';
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /**
   * opts: { type:'line'|'bar', series:[{name,color,values}], x:(i)=>label,
   *         xTicks:[i...], yFmt:(v)=>str, xTitle, height, fill }
   */
  function draw(host, opts) {
    if (host._ro) host._ro.disconnect();
    host.replaceChildren();
    host.classList.add('chart');
    const canvas = document.createElement('canvas');
    const tip = document.createElement('div');
    tip.className = 'chart-tip'; tip.hidden = true;
    host.append(canvas, tip);

    if (opts.series.length > 1) {
      const lg = document.createElement('div');
      lg.className = 'legend';
      opts.series.forEach(s => {
        const it = document.createElement('span');
        const sw = document.createElement('i'); sw.style.background = s.color;
        it.append(sw, document.createTextNode(s.name));
        lg.appendChild(it);
      });
      host.prepend(lg);
    }

    const H = opts.height || 180;
    const n = opts.series[0].values.length;
    const pad = { l: 44, r: 12, t: 10, b: opts.xTitle ? 34 : 22 };
    let W = 0, hover = -1;
    const yMax = opts.yMax || Math.max(...opts.series.flatMap(s => s.values)) * 1.08 || 1;
    const yMin = opts.yMin != null ? opts.yMin : 0;

    function render() {
      const dpr = window.devicePixelRatio || 1;
      W = host.clientWidth;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      canvas.width = W * dpr; canvas.height = H * dpr;
      const x = canvas.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, H);
      const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
      const X = i => pad.l + (opts.type === 'bar' ? (i + 0.5) * pw / n : i * pw / (n - 1));
      const Yv = v => pad.t + ph - (v - yMin) / (yMax - yMin) * ph;

      // grid & sumbu (resesif)
      x.font = '11px ' + css('--mono');
      x.fillStyle = css('--muted');
      x.strokeStyle = css('--line');
      x.lineWidth = 1;
      for (let g = 0; g <= 3; g++) {
        const v = yMin + (yMax - yMin) * g / 3, y = Math.round(Yv(v)) + 0.5;
        x.beginPath(); x.moveTo(pad.l, y); x.lineTo(W - pad.r, y); x.stroke();
        x.textAlign = 'right'; x.textBaseline = 'middle';
        x.fillText(opts.yFmt ? opts.yFmt(v) : v.toFixed(1), pad.l - 6, y);
      }
      x.textAlign = 'center'; x.textBaseline = 'top';
      (opts.xTicks || []).forEach(i => {
        const t = (opts.tick || opts.x)(i), half = x.measureText(t).width / 2;
        const cx = Math.min(W - 2 - half, Math.max(half + 2, X(i))); // jaga label tetap di dalam kanvas
        x.fillText(t, cx, pad.t + ph + 6);
      });
      if (opts.xTitle) { x.fillText(opts.xTitle, pad.l + pw / 2, H - 13); }

      // data
      opts.series.forEach(s => {
        if (opts.type === 'bar') {
          const bw = Math.max(1, pw / n - 2);
          x.fillStyle = s.color;
          s.values.forEach((v, i) => {
            const y = Yv(v), y0 = Yv(yMin);
            if (y0 - y < 0.5) return;
            x.globalAlpha = hover === -1 || hover === i ? 1 : 0.55;
            roundTop(x, X(i) - bw / 2, y, bw, y0 - y, Math.min(4, bw / 2));
          });
          x.globalAlpha = 1;
        } else {
          x.strokeStyle = s.color; x.lineWidth = 2; x.lineJoin = 'round';
          x.beginPath();
          s.values.forEach((v, i) => { i ? x.lineTo(X(i), Yv(v)) : x.moveTo(X(i), Yv(v)); });
          x.stroke();
          if (opts.fill) {
            x.lineTo(X(n - 1), Yv(yMin)); x.lineTo(X(0), Yv(yMin)); x.closePath();
            x.globalAlpha = 0.12; x.fillStyle = s.color; x.fill(); x.globalAlpha = 1;
          }
        }
      });

      // crosshair
      if (hover >= 0 && opts.type !== 'bar') {
        x.strokeStyle = css('--muted'); x.lineWidth = 1; x.setLineDash([3, 3]);
        x.beginPath(); x.moveTo(X(hover), pad.t); x.lineTo(X(hover), pad.t + ph); x.stroke();
        x.setLineDash([]);
        opts.series.forEach(s => {
          x.beginPath(); x.arc(X(hover), Yv(s.values[hover]), 4, 0, 7);
          x.fillStyle = s.color; x.fill();
          x.lineWidth = 2; x.strokeStyle = css('--panel'); x.stroke();
        });
      }
      return { X, pw };
    }

    function roundTop(x, l, t, w, h, r) {
      r = Math.min(r, h);
      x.beginPath();
      x.moveTo(l, t + h); x.lineTo(l, t + r); x.quadraticCurveTo(l, t, l + r, t);
      x.lineTo(l + w - r, t); x.quadraticCurveTo(l + w, t, l + w, t + r); x.lineTo(l + w, t + h);
      x.closePath(); x.fill();
    }

    let geo = render();
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const pw = geo.pw;
      let i = opts.type === 'bar' ? Math.floor((mx - pad.l) / (pw / n)) : Math.round((mx - pad.l) / (pw / (n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      if (i !== hover) { hover = i; geo = render(); }
      tip.replaceChildren();
      const head = document.createElement('b'); head.textContent = opts.x(i);
      tip.appendChild(head);
      opts.series.forEach(s => {
        const row = document.createElement('div');
        const sw = document.createElement('i'); sw.style.background = s.color;
        row.append(sw, document.createTextNode(`${s.name}: ${opts.yFmt ? opts.yFmt(s.values[i], true) : s.values[i].toFixed(3)}`));
        tip.appendChild(row);
      });
      tip.hidden = false;
      const tx = geo.X(i) + 12, tw = tip.offsetWidth;
      tip.style.left = (tx + tw > W ? geo.X(i) - tw - 12 : tx) + 'px';
      tip.style.top = (e.clientY - host.getBoundingClientRect().top - 20) + 'px';
    });
    canvas.addEventListener('mouseleave', () => { hover = -1; tip.hidden = true; geo = render(); });
    const ro = new ResizeObserver(() => { if (host.clientWidth !== W) geo = render(); });
    ro.observe(host);
    host._ro = ro;
  }

  return { draw };
})();
