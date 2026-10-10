/* Grad Dossier client: unlock, render, and keep per-device progress. No dependencies. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const KEY_STORE = 'dossier.key.v1';
  const PROGRESS_STORE = 'dossier.progress.v1';
  const THEME_STORE = 'dossier.theme.v1';

  // Storage can be unavailable (private mode, blocked site data). Every access is guarded,
  // and the page works without it.
  const storage = (area) => ({
    get(k) { try { return window[area].getItem(k); } catch { return null; } },
    set(k, v) { try { window[area].setItem(k, v); return true; } catch { return false; } },
    del(k) { try { window[area].removeItem(k); } catch { /* ignore */ } },
  });
  const local = storage('localStorage');
  const session = storage('sessionStorage');

  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  // ---------- theme ----------

  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const btn = $('#theme');
    if (btn) {
      const label = t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark';
      btn.textContent = label;
      btn.setAttribute('aria-label', `Colour theme: ${label.toLowerCase()}. Switch theme`);
    }
  }
  let theme = local.get(THEME_STORE) || 'system';
  if (!THEMES.includes(theme)) theme = 'system';
  applyTheme(theme);

  // ---------- payload ----------

  let envelope;
  try {
    envelope = JSON.parse($('#payload').textContent);
  } catch {
    document.body.textContent = 'The dossier data is missing or damaged. Rebuild the site with build.mjs.';
    return;
  }

  async function deriveKey(passphrase) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(envelope.salt), iterations: envelope.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt'],
    );
  }

  async function decryptWith(key) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ct),
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function importStoredKey(raw) {
    return crypto.subtle.importKey('raw', b64ToBytes(raw), { name: 'AES-GCM' }, true, ['decrypt']);
  }

  async function tryStoredKeys() {
    for (const store of [session, local]) {
      const raw = store.get(KEY_STORE);
      if (!raw) continue;
      try {
        return await decryptWith(await importStoredKey(raw));
      } catch {
        store.del(KEY_STORE); // Passphrase or salt changed since this device was unlocked.
      }
    }
    return null;
  }

  function showLock() {
    $('#app').hidden = true;
    $('#lock').hidden = false;
    if (!window.crypto || !crypto.subtle) {
      const err = $('#lock-error');
      err.textContent = 'This browser cannot decrypt the dossier here. Open the site over https in a current browser.';
      err.hidden = false;
      $('#unlock').disabled = true;
      return;
    }
    $('#passphrase').focus();
  }

  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#unlock');
    const err = $('#lock-error');
    const pass = $('#passphrase').value;
    if (!pass) return;
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    err.hidden = true;
    try {
      const key = await deriveKey(pass);
      const data = await decryptWith(key);
      const raw = bytesToB64(await crypto.subtle.exportKey('raw', key));
      session.set(KEY_STORE, raw);
      if ($('#remember').checked) local.set(KEY_STORE, raw);
      $('#passphrase').value = '';
      render(data);
    } catch {
      err.textContent = 'That passphrase did not unlock the dossier. Check it and try again.';
      err.hidden = false;
      $('#passphrase').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });

  $('#lock-now').addEventListener('click', () => {
    session.del(KEY_STORE);
    local.del(KEY_STORE);
    location.reload();
  });

  $('#theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    if (theme === 'system') local.del(THEME_STORE); else local.set(THEME_STORE, theme);
    applyTheme(theme);
  });

  // ---------- dates ----------

  const DAY = 86400000;
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const fmtLong = (d) => d.toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (d) => d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short' });
  const daysUntil = (d) => Math.round((d - today()) / DAY);

  // ---------- render ----------

  let currentData = null;

  function render(data) {
    currentData = data;
    $('#lock').hidden = true;
    $('#app').hidden = false;
    $('#lock-now').hidden = envelope.mode !== 'enc';
    document.title = 'Grad Dossier 2027';

    $('#title').textContent = data.title.replace(/\s+—\s+Plug-and-Play Dossier$/, '');
    $('#edition').textContent = `Plug-and-play dossier, second edition. Site built ${fmtLong(parseDate(data.updated))}.`;
    $('#built').textContent = `Content exported from the working document on ${fmtLong(parseDate(data.updated))}. Dates for 2027 calls that are not yet published repeat the 2026 dates.`;

    const article = $('#dossier');
    article.innerHTML = data.html; // Built by the owner from their own document; not user-supplied text.

    enhanceTables(article);
    enhanceTasks(article);
    enhanceDates(article);
    buildToc(article);
    renderSky(data.deadlines || []);
    renderNextUp(data.deadlines || []);
    wireProgressFiles();

    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) target.scrollIntoView();
    }
  }

  // ---------- tables ----------

  const VERDICTS = [
    [/^apply( \(hedge\)| if eligible)?$/i, 'apply'],
    [/^verify before applying$/i, 'verify'],
    [/^hold/i, 'hold'],
    [/^out$/i, 'out'],
  ];
  const CONFIDENCE = [
    [/^verified/i, 'verified'],
    [/^partly verified/i, 'partly'],
    [/^uncertain/i, 'uncertain'],
  ];

  function enhanceTables(root) {
    $$('table', root).forEach((table, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      const heading = findPrecedingHeading(table);
      wrap.setAttribute('aria-label', heading ? `${heading} table, scrollable` : `Table ${i + 1}, scrollable`);
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);

      // Put the verdict right after the programme name: it is what you scan for.
      let headers = $$('thead th', table).map((th) => th.textContent.trim().toLowerCase());
      const vi = headers.indexOf('verdict');
      if (vi > 1) {
        $$('tr', table).forEach((tr) => {
          const cells = tr.children;
          if (cells[vi] && cells[1]) tr.insertBefore(cells[vi], cells[1]);
        });
        headers = $$('thead th', table).map((th) => th.textContent.trim().toLowerCase());
      }
      const verdictCol = headers.indexOf('verdict');
      const confCol = headers.indexOf('confidence');
      const askCol = headers.findIndex((h) => h.startsWith('the exact ask'));

      $$('tbody tr', table).forEach((tr) => {
        const cells = $$('td', tr);
        if (verdictCol >= 0 && cells[verdictCol]) {
          const text = cells[verdictCol].textContent.trim();
          const hit = VERDICTS.find(([re]) => re.test(text));
          if (hit) {
            cells[verdictCol].innerHTML = `<span class="verdict" data-kind="${hit[1]}">${escapeHtml(text)}</span>`;
            if (hit[1] === 'out') tr.classList.add('is-out');
          }
        }
        if (confCol >= 0 && cells[confCol]) {
          const text = cells[confCol].textContent.trim();
          const hit = CONFIDENCE.find(([re]) => re.test(text));
          if (hit && text.length < 40) {
            cells[confCol].innerHTML = `<span class="conf" data-kind="${hit[1]}">${escapeHtml(text)}</span>`;
          }
        }
        if (askCol >= 0 && cells[askCol]) addCopyButton(cells[askCol]);
        cells.forEach((td) => { if (td.textContent.length > 160) td.classList.add('wide'); });
      });
    });
  }

  function findPrecedingHeading(node) {
    let n = node.previousElementSibling;
    while (n) {
      if (/^H[23]$/.test(n.tagName)) return n.textContent.trim();
      n = n.previousElementSibling;
    }
    return '';
  }

  function addCopyButton(td) {
    const text = td.textContent.trim().replace(/^["“]|["”]$/g, '');
    const inner = td.innerHTML;
    td.innerHTML = `<div class="ask"><div>${inner}</div></div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = 'Copy text';
    btn.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = fallbackCopy(text); }
      btn.dataset.state = ok ? 'done' : 'fail';
      btn.textContent = ok ? 'Copied' : 'Select and copy manually';
      setTimeout(() => { btn.textContent = 'Copy text'; delete btn.dataset.state; }, 2200);
    });
    $('.ask', td).appendChild(btn);
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- tasks (per-device progress) ----------

  function hash(str) {
    let h = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function readProgress() {
    try {
      const p = JSON.parse(local.get(PROGRESS_STORE) || 'null');
      if (p && p.v === 1 && p.items && typeof p.items === 'object') return p;
    } catch { /* fall through */ }
    return { v: 1, items: {} };
  }

  function writeProgress(p) {
    if (!local.set(PROGRESS_STORE, JSON.stringify(p))) {
      $('#foot-status').textContent = 'This browser is not saving ticks. Use “Save progress file” to keep them.';
    }
  }

  let progress = readProgress();

  function enhanceTasks(root) {
    $$('li', root).forEach((li) => {
      const box = li.firstElementChild;
      if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox') return;
      const label = document.createElement('label');
      const span = document.createElement('span');
      // Move the item's text (everything after the checkbox) into the label.
      while (box.nextSibling) span.appendChild(box.nextSibling);
      const text = span.textContent.replace(/\s+/g, ' ').trim();
      const id = hash(text);
      box.removeAttribute('disabled');
      box.dataset.task = id;
      box.checked = Boolean(progress.items[id] && progress.items[id].done) || box.hasAttribute('checked');
      label.append(box, span);
      li.appendChild(label);
      li.classList.add('task');
      li.classList.toggle('done', box.checked);
      box.addEventListener('change', () => {
        progress = readProgress(); // pick up changes made in another tab
        progress.items[id] = { done: box.checked, at: new Date().toISOString(), label: text.slice(0, 120) };
        writeProgress(progress);
        li.classList.toggle('done', box.checked);
      });
    });
  }

  function wireProgressFiles() {
    const status = $('#foot-status');
    $('#export').onclick = () => {
      const blob = new Blob([JSON.stringify(readProgress(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `dossier-progress-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      status.textContent = 'Progress file saved.';
    };
    $('#import').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const incoming = JSON.parse(await file.text());
        if (!incoming || incoming.v !== 1 || typeof incoming.items !== 'object') throw new Error('shape');
        const current = readProgress();
        // Merge: for each task keep whichever record is newer. Nothing is deleted.
        for (const [id, rec] of Object.entries(incoming.items)) {
          const mine = current.items[id];
          if (!mine || String(rec.at || '') > String(mine.at || '')) current.items[id] = rec;
        }
        writeProgress(current);
        progress = current;
        $$('input[data-task]').forEach((box) => {
          const rec = current.items[box.dataset.task];
          box.checked = Boolean(rec && rec.done);
          box.closest('li').classList.toggle('done', box.checked);
        });
        status.textContent = 'Progress file loaded and merged.';
      } catch {
        status.textContent = 'That file is not a dossier progress file. Nothing was changed.';
      } finally {
        e.target.value = '';
      }
    };
  }

  // ---------- inline dates ----------

  function enhanceDates(root) {
    // Highlight exported date chips ("Oct 31, 2026") inside task items so deadlines stand out.
    const re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, 20\d\d\b/g;
    $$('li.task span', root).forEach((span) => {
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        if (!re.test(node.nodeValue)) return;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        node.nodeValue.replace(re, (m, _mon, offset) => {
          frag.append(node.nodeValue.slice(last, offset));
          const t = document.createElement('time');
          t.className = 'chip';
          const d = new Date(m);
          if (!Number.isNaN(d.getTime())) t.dateTime = d.toISOString().slice(0, 10);
          t.textContent = m;
          frag.append(t);
          last = offset + m.length;
          return m;
        });
        frag.append(node.nodeValue.slice(last));
        node.replaceWith(frag);
      });
    });
  }

  // ---------- table of contents ----------

  function buildToc(root) {
    const heads = $$('h2', root);
    const make = () => heads.map((h) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      li.appendChild(a);
      return li;
    });
    $('#toc-list').replaceChildren(...make());
    $('#toc-list-mobile').replaceChildren(...make());
    $('#toc-list-mobile').addEventListener('click', (e) => {
      if (e.target.closest('a')) $('#toc-mobile').open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#toc-mobile').open) { $('#toc-mobile').open = false; $('#toc-mobile summary').focus(); }
    });

    // Mark the section being read: the last heading that has scrolled past the top bar.
    const links = $$('#toc-list a, #toc-list-mobile a');
    let ticking = false;
    const update = () => {
      ticking = false;
      let current = heads[0];
      for (const h of heads) { if (h.getBoundingClientRect().top < 140) current = h; else break; }
      links.forEach((a) => a.setAttribute('aria-current', String(Boolean(current) && a.hash === `#${current.id}`)));
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // ---------- next up ----------

  function renderNextUp(items) {
    const el = $('#next-up');
    const upcoming = items
      .map((it) => ({ ...it, d: parseDate(it.date) }))
      .filter((it) => daysUntil(it.d) >= 0)
      .sort((a, b) => a.d - b.d);
    if (!upcoming.length) { el.textContent = 'Every listed deadline has passed.'; return; }
    const n = upcoming[0];
    const days = daysUntil(n.d);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    const est = n.status === 'estimated' ? ' (2026 date; 2027 not yet published)' : '';
    el.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = `Next: ${n.label}`;
    el.append(strong, `, ${when}, on ${fmtLong(n.d)}${est}.`);
  }

  // ---------- the constellation ----------

  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, text) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  };

  const starPath = (cx, cy, r) => {
    const i = r * 0.32;
    return `M${cx} ${cy - r} L${cx + i} ${cy - i} L${cx + r} ${cy} L${cx + i} ${cy + i} L${cx} ${cy + r} L${cx - i} ${cy + i} L${cx - r} ${cy} L${cx - i} ${cy - i} Z`;
  };
  const diamondPath = (cx, cy, r) => `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`;

  function renderSky(items) {
    const host = $('#sky-chart');
    const list = $('#sky-list');
    if (!items.length) { $('#sky').hidden = true; return; }

    const pts = items.map((it) => ({ ...it, d: parseDate(it.date) })).sort((a, b) => a.d - b.d);
    const t0 = today();
    const start = new Date(Math.min(t0, pts[0].d) - 10 * DAY);
    const end = new Date(Math.max(t0, pts[pts.length - 1].d) + 18 * DAY);

    const width = Math.max(host.parentElement.clientWidth || 720, 760);
    const H = 236, padX = 28, axisY = 150;
    const x = (d) => padX + ((d - start) / (end - start)) * (width - padX * 2);

    const svg = svgEl('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, 'aria-hidden': 'true', focusable: 'false' });

    // month ticks
    svg.append(svgEl('line', { class: 'axis', x1: padX, x2: width - padX, y1: axisY, y2: axisY }));
    const m = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    while (m < end) {
      const mx = x(m);
      svg.append(svgEl('line', { class: 'tickline', x1: mx, x2: mx, y1: axisY, y2: axisY + 6 }));
      const label = m.getMonth() === 0 ? `${m.toLocaleDateString('en-CA', { month: 'short' })} ${m.getFullYear()}` : m.toLocaleDateString('en-CA', { month: 'short' });
      svg.append(svgEl('text', { class: 'tick', x: mx + 4, y: axisY + 22 }, label));
      m.setMonth(m.getMonth() + 1);
    }

    // star heights: a gentle constellation above the axis
    const heights = [96, 62, 108, 70, 44, 88, 58, 100];
    pts.forEach((p, i) => { p.x = x(p.d); p.y = heights[i % heights.length]; });

    // constellation path
    svg.append(svgEl('path', { class: 'path', d: pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') }));

    // labels: greedy placement into rows above each star, avoiding overlap
    const rowsTaken = [];
    const charW = 7.1;
    pts.forEach((p) => {
      const w = Math.max(p.label.length, 8) * charW;
      const left = p.x - w / 2, right = p.x + w / 2;
      let row = 0;
      while (rowsTaken[row] && rowsTaken[row].some(([l, r]) => !(right + 8 < l || left - 8 > r))) row++;
      (rowsTaken[row] = rowsTaken[row] || []).push([left, right]);
      p.row = row;
    });

    // today
    const tx = x(t0);
    svg.append(svgEl('line', { class: 'today', x1: tx, x2: tx, y1: 14, y2: axisY }));
    svg.append(svgEl('text', { class: 'today-lbl', x: tx + 5, y: axisY - 6 }, 'Today'));

    pts.forEach((p, i) => {
      const past = p.d < t0;
      const g = svgEl('g', { class: past ? 'past' : '' });
      g.append(svgEl('line', { class: 'leader', x1: p.x, x2: p.x, y1: p.y + 10, y2: axisY }));
      const cls = p.kind === 'gate' ? 's-gate' : p.status === 'confirmed' ? 's-confirmed' : 's-estimated';
      const shape = svgEl('path', {
        class: `${cls} star-in`,
        d: p.kind === 'gate' ? diamondPath(p.x, p.y, 7) : starPath(p.x, p.y, p.status === 'confirmed' ? 10 : 9),
        style: `animation-delay:${120 + i * 90}ms; transform-box: fill-box; transform-origin: center;`,
      });
      g.append(shape);
      // Labels sit in rows along the bottom band so they never collide with stars.
      const ly = axisY + 42 + p.row * 30;
      const anchorX = Math.min(Math.max(p.x, padX + 40), width - padX - 40);
      g.append(svgEl('text', { class: 'lbl', x: anchorX, y: ly, 'text-anchor': 'middle' }, p.label));
      g.append(svgEl('text', { class: 'lbl-date', x: anchorX, y: ly + 14, 'text-anchor': 'middle' }, fmtShort(p.d)));
      svg.append(g);
    });

    const rows = rowsTaken.length;
    const totalH = axisY + 42 + (rows - 1) * 30 + 24;
    svg.setAttribute('height', totalH);
    svg.setAttribute('viewBox', `0 0 ${width} ${totalH}`);

    host.replaceChildren(svg);

    list.replaceChildren(...pts.map((p) => {
      const li = document.createElement('li');
      const kind = p.kind === 'gate' ? 'Your gate' : p.status === 'confirmed' ? 'Confirmed deadline' : 'Estimated deadline (2026 date)';
      li.textContent = `${p.label}: ${fmtLong(p.d)}. ${kind}.`;
      return li;
    }));

    // Start scrolled so "today" is visible on narrow screens.
    const scroller = host.parentElement;
    scroller.scrollLeft = Math.max(0, tx - 40);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!$('#app').hidden && currentData) renderSky(currentData.deadlines || []);
    }, 200);
  });

  // ---------- boot ----------

  async function boot() {
    if (envelope.mode === 'plain') { render(envelope.data); return; }
    if (window.crypto && crypto.subtle) {
      const data = await tryStoredKeys();
      if (data) { render(data); return; }
    }
    showLock();
  }

  boot();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
