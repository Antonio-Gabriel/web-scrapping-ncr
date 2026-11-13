(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_ROWS = 600;
  // Fonte acompanhada nesta página (NCR por omissão).
  const FONTE = document.getElementById('live-config')?.dataset.fonte || 'ncr';
  const FQ = FONTE === 'ncr' ? '' : `?fonte=${encodeURIComponent(FONTE)}`;
  const KINDS = {
    start: ['Início', 'tone-info'], phase: ['Etapa', 'tone-promo'], navigate: ['Abrir', 'tone-info'], loaded: ['Aberta', 'tone-good'],
    click: ['Clique', 'tone-promo'], request: ['Pedido', 'tone-neutral'], progress: ['Leitura', 'tone-neutral'], info: ['Info', 'tone-neutral'],
    warn: ['Aviso', 'tone-warning'], done: ['Fim', 'tone-good'], error: ['Erro', 'tone-critical'],
  };
  const time = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', timeStyle: 'medium' });
  const phaseEls = [...document.querySelectorAll('#live-phases [data-phase]')];
  const feed = $('live-feed');
  const bar = { box: $('live-progress'), text: $('live-progress-text'), count: $('live-progress-count'), fill: $('live-progress-bar') };

  let state;
  let follow = true;
  let latestFrame = null;
  let decoding = false;
  let framesThisSecond = 0;
  let fps = 0;
  let lastFrameAt = 0;

  const fresh = () => ({ running: false, connected: true, startedAt: null, endedAt: null, outcome: null, live: null, phase: null, count: 0 });

  function resetView({ keepImage = false } = {}) {
    state = fresh();
    feed.replaceChildren();
    $('live-url').textContent = 'Sem página aberta';
    if (!keepImage) {
      $('live-frame').classList.add('hidden');
      $('live-empty').classList.remove('hidden');
      latestFrame = null;
      lastFrameAt = 0;
    }
    bar.box.classList.add('hidden');
    renderPhases();
  }

  function renderPhases() {
    const current = phaseEls.findIndex((el) => el.dataset.phase === state.phase);
    phaseEls.forEach((el, i) => {
      const finished = current > i || state.outcome === 'success' || state.outcome === 'partial';
      const active = i === current && !state.outcome;
      const failed = i === current && state.outcome === 'failed';
      el.dataset.state = failed ? 'failed' : finished ? 'done' : active ? 'active' : 'pending';
      if (active) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    });
  }

  function renderStatus() {
    const el = $('live-status');
    let text = 'Sem execução a decorrer';
    let tone = 'tone-neutral';
    if (!state.connected) { text = 'A religar ao dashboard…'; tone = 'tone-warning'; }
    else if (state.running && !state.outcome) { text = 'A decorrer'; tone = 'tone-info'; }
    else if (state.outcome === 'success') { text = 'Concluída'; tone = 'tone-good'; }
    else if (state.outcome === 'partial') { text = 'Concluída com recolha parcial'; tone = 'tone-warning'; }
    else if (state.outcome === 'failed') { text = 'Falhou'; tone = 'tone-critical'; }
    else if (state.startedAt) { text = 'Interrompida'; tone = 'tone-serious'; }
    el.className = `chip ${tone}`;
    el.textContent = text;
    const busy = state.running && !state.outcome;
    $('live-run').disabled = busy;

    const empty = $('live-frame').classList.contains('hidden');
    if (empty) {
      let title = 'Sem imagem por agora';
      let sub = 'Carrega em "Rodar agora" para veres o browser a trabalhar.';
      if (state.startedAt && state.live === false) {
        title = 'Esta execução não transmite imagem';
        sub = 'Só as execuções iniciadas por "Rodar agora" mostram o browser. As automáticas e as feitas pela linha de comandos só escrevem o registo.';
      } else if (busy) {
        title = 'À espera da primeira imagem';
        sub = 'O browser está a arrancar.';
      }
      $('live-empty-title').textContent = title;
      $('live-empty-text').textContent = sub;
    }
  }

  function renderElapsed() {
    const el = $('live-elapsed');
    if (!state.startedAt) { el.textContent = ''; return; }
    const end = state.endedAt || (state.running ? Date.now() : state.lastAt || Date.now());
    const s = Math.max(0, Math.round((end - state.startedAt) / 1000));
    el.textContent = `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  }

  function addRow(e) {
    const [label, tone] = KINDS[e.kind] || [e.kind, 'tone-neutral'];
    const li = document.createElement('li');
    li.className = 'grid grid-cols-[auto_1fr] gap-x-2.5 px-4 py-2';
    const chip = document.createElement('span');
    chip.className = `chip ${tone} self-start`;
    chip.textContent = label;
    const body = document.createElement('div');
    body.className = 'min-w-0';
    const text = document.createElement('p');
    text.className = 'break-words text-[13px]';
    text.textContent = e.text;
    const meta = document.createElement('p');
    meta.className = 'text-[11px] tabular-nums text-ink-mute';
    const extra = [];
    if (e.status) extra.push(typeof e.status === 'number' ? `HTTP ${e.status}` : '');
    if (e.ms != null) extra.push(`${e.ms} ms`);
    if (e.x != null) extra.push(`posição x ${e.x}, y ${e.y}`);
    meta.textContent = [time.format(new Date(e.at)), ...extra.filter(Boolean)].join(' · ');
    body.append(text, meta);
    li.append(chip, body);
    feed.append(li);
    while (feed.childElementCount > MAX_ROWS) feed.firstElementChild.remove();
  }

  function onActivity(e) {
    state.count++;
    state.lastAt = +new Date(e.at);
    if (e.kind === 'start') { state.startedAt = +new Date(e.at); state.live = e.live; state.running = true; }
    if (e.kind === 'phase') { state.phase = e.phase; bar.box.classList.add('hidden'); renderPhases(); }
    if (e.kind === 'navigate') $('live-url').textContent = e.url;
    if (e.kind === 'progress' && e.total) {
      bar.box.classList.remove('hidden');
      bar.text.textContent = e.text;
      bar.count.textContent = `${e.done} de ${e.total}`;
      bar.fill.style.width = `${Math.min(100, (e.done / e.total) * 100)}%`;
    }
    if (e.kind === 'done' || e.kind === 'error') {
      state.outcome = e.status;
      state.endedAt = +new Date(e.at);
      bar.box.classList.add('hidden');
      renderPhases();
    }
    addRow(e);
  }

  /** Desenha sempre a imagem mais recente; as intermédias são saltadas se o computador não acompanhar. */
  async function drawLatest() {
    if (decoding) return;
    decoding = true;
    while (latestFrame) {
      const bytes = latestFrame;
      latestFrame = null;
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const canvas = $('live-frame');
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        canvas.classList.remove('hidden');
        $('live-empty').classList.add('hidden');
      } catch { /* imagem inválida: a seguinte substitui-a */ }
    }
    decoding = false;
  }

  function renderBadge() {
    const el = $('live-badge');
    const busy = state.running && !state.outcome;
    const hasImage = !$('live-frame').classList.contains('hidden');
    el.classList.toggle('hidden', !hasImage);
    el.classList.toggle('inline-flex', hasImage);
    if (!busy) { el.textContent = 'Última imagem'; return; }
    el.textContent = fps > 0 ? `● Em direto · ${fps} imagens/s` : '● Em direto · página sem alterações';
  }

  /** Recebe o vídeo em contínuo: 4 bytes com o tamanho, seguidos da imagem. */
  async function playVideo() {
    for (;;) {
      try {
        const res = await fetch(`/execucoes/ao-vivo/video${FQ}`, { cache: 'no-store' });
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const joined = new Uint8Array(buf.length + value.length);
          joined.set(buf);
          joined.set(value, buf.length);
          buf = joined;
          let offset = 0;
          while (buf.length - offset >= 4) {
            const len = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0);
            if (buf.length - offset < 4 + len) break;
            latestFrame = buf.slice(offset + 4, offset + 4 + len);
            framesThisSecond++;
            lastFrameAt = Date.now();
            offset += 4 + len;
          }
          if (offset) buf = buf.slice(offset);
          if (latestFrame) drawLatest();
        }
      } catch { /* servidor reiniciado: volta a ligar */ }
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
  }

  setInterval(() => {
    fps = framesThisSecond;
    framesThisSecond = 0;
    renderBadge();
  }, 1000);

  const scrollToEnd = () => { feed.scrollTop = feed.scrollHeight; };
  feed.addEventListener('scroll', () => {
    follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    $('live-follow').classList.toggle('hidden', follow);
  });
  $('live-follow').addEventListener('click', () => { follow = true; scrollToEnd(); $('live-follow').classList.add('hidden'); });

  resetView();
  renderStatus();
  setInterval(renderElapsed, 1000);

  const stream = new EventSource(`/execucoes/ao-vivo/stream${FQ}`);
  const afterUpdate = () => {
    $('live-count').textContent = `${state.count} eventos`;
    renderStatus();
    renderElapsed();
    if (follow) scrollToEnd();
  };
  stream.addEventListener('open', () => { state.connected = true; renderStatus(); });
  stream.addEventListener('error', () => { state.connected = false; renderStatus(); });
  stream.addEventListener('reset', () => { resetView(); afterUpdate(); });
  stream.addEventListener('replay', () => { resetView({ keepImage: true }); afterUpdate(); });
  stream.addEventListener('activity', (m) => { onActivity(JSON.parse(m.data)); afterUpdate(); });
  stream.addEventListener('status', (m) => { state.running = JSON.parse(m.data).running; afterUpdate(); });
  playVideo();
})();
