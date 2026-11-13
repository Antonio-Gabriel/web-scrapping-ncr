(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const tip = document.getElementById('tooltip');
  const money = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
  const plain = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1, useGrouping: 'always' });
  const when = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', dateStyle: 'short', timeStyle: 'short' });
  const day = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', day: '2-digit', month: 'short' });
  const hour = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', hour: '2-digit', minute: '2-digit' });

  function showTip(text, x, y) {
    tip.textContent = text;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - r.width - 8))}px`;
    tip.style.top = `${y - r.height - 12 < 8 ? y + 16 : y - r.height - 12}px`;
  }
  const hideTip = () => { tip.style.display = 'none'; };

  document.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('pointermove', (e) => showTip(el.dataset.tip, e.clientX, e.clientY));
    el.addEventListener('pointerleave', hideTip);
    el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); showTip(el.dataset.tip, r.left, r.top); });
    el.addEventListener('blur', hideTip);
  });

  const node = (name, attrs, parent) => {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent?.appendChild(n);
    return n;
  };
  const compact = (v, kz) => {
    const a = Math.abs(v);
    const s = a >= 1e6 ? `${plain.format(v / 1e6)} M` : a >= 1e4 ? `${plain.format(v / 1e3)} mil` : plain.format(v);
    return kz ? `${s} Kz` : s;
  };

  function drawLine(host) {
    const points = JSON.parse(host.dataset.points).map((p) => ({ t: +new Date(p.t), v: p.v }));
    const isKz = host.dataset.format === 'kz';
    host.replaceChildren();
    const W = Math.max(host.clientWidth, 240); const H = 190;
    const m = { top: 12, right: 14, bottom: 24, left: isKz ? 72 : 48 };
    host.replaceChildren();
    const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'block', role: 'img', 'aria-label': `${host.dataset.title}: ${points.length} leituras` }, host);
    let lo = Math.min(...points.map((p) => p.v)); let hi = Math.max(...points.map((p) => p.v));
    const pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.05, 1);
    lo = Math.max(0, lo - pad); hi += pad;
    // Contagens não têm frações: o eixo usa só números inteiros.
    if (!isKz) { lo = Math.floor(lo); hi = Math.max(Math.ceil(hi), lo + 1); }
    const ticks = isKz ? 3 : Math.min(3, hi - lo);
    const t0 = points[0].t; const t1 = points.at(-1).t;
    const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * (W - m.left - m.right);
    const y = (v) => H - m.bottom - ((v - lo) / (hi - lo || 1)) * (H - m.top - m.bottom);
    const label = (txt, attrs) => { const n = node('text', { 'font-size': 11, fill: '#75746e', ...attrs }, svg); n.textContent = txt; return n; };

    for (let i = 0; i <= ticks; i++) {
      const raw = lo + ((hi - lo) * i) / ticks;
      const v = isKz ? raw : Math.round(raw);
      node('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: i ? '#efeee9' : '#d6d5ce', 'stroke-width': 1 }, svg);
      label(compact(v, isKz), { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
    }
    const span = t1 - t0; const fmtX = span < 86400000 * 2 ? hour : day;
    label(fmtX.format(t0), { x: m.left, y: H - 7 });
    label(fmtX.format(t1), { x: W - m.right, y: H - 7, 'text-anchor': 'end' });

    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    node('path', { d: `${path} L${x(t1)} ${H - m.bottom} L${x(t0)} ${H - m.bottom} Z`, fill: '#2a78d6', 'fill-opacity': 0.1 }, svg);
    node('path', { d: path, fill: 'none', stroke: '#2a78d6', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const last = points.at(-1);
    node('circle', { cx: x(last.t), cy: y(last.v), r: 4, fill: '#2a78d6', stroke: '#fff', 'stroke-width': 2 }, svg);

    const cross = node('line', { y1: m.top, y2: H - m.bottom, stroke: '#a9a8a0', 'stroke-width': 1, visibility: 'hidden' }, svg);
    const dot = node('circle', { r: 4, fill: '#2a78d6', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }, svg);
    const hit = node('rect', { x: m.left, y: 0, width: W - m.left - m.right, height: H, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const px = (e.clientX - box.left) * (W / box.width);
      const near = points.reduce((a, b) => (Math.abs(x(b.t) - px) < Math.abs(x(a.t) - px) ? b : a));
      cross.setAttribute('x1', x(near.t)); cross.setAttribute('x2', x(near.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(near.t)); dot.setAttribute('cy', y(near.v)); dot.setAttribute('visibility', 'visible');
      showTip(`${when.format(near.t)} · ${isKz ? `${money.format(near.v)} Kz` : plain.format(near.v)}`, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  const charts = [...document.querySelectorAll('[data-line-chart]')];
  charts.forEach(drawLine);
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => charts.forEach(drawLine), 150); });

  document.querySelectorAll('form[data-autosubmit] select').forEach((s) => s.addEventListener('change', () => s.form.requestSubmit()));

  // Menus de exportação: fecham ao clicar fora ou com Esc.
  const menus = [...document.querySelectorAll('details[data-menu]')];
  document.addEventListener('click', (e) => menus.forEach((m) => { if (!m.contains(e.target)) m.open = false; }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menus.forEach((m) => { m.open = false; }); });

  const sidebar = document.getElementById('sidebar'); const backdrop = document.getElementById('backdrop');
  const toggle = (open) => { sidebar.classList.toggle('hidden', !open); sidebar.classList.toggle('flex', open); backdrop.classList.toggle('hidden', !open); };
  document.getElementById('menu-btn')?.addEventListener('click', () => toggle(sidebar.classList.contains('hidden')));
  backdrop?.addEventListener('click', () => toggle(false));
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('global-search')?.focus(); }
  });
})();
