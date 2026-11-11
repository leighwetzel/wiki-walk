(() => {
  'use strict';
  const VERSION = '1.2.2';
  const W = window.WW;
  const $ = (id) => document.getElementById(id);
  const API = 'https://en.wikipedia.org/w/api.php';
  const API_HEADERS = { 'Api-User-Agent': 'WikiWalk/1.0 (https://walk.xoleigh.com; family walking-tour app)' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  /* ---------- IndexedDB (articles + saved places) ---------- */
  const db = (() => {
    let p;
    function open() {
      if (!p) {
        p = new Promise((res, rej) => {
          const r = indexedDB.open('wikiwalk', 2);
          r.onupgradeneeded = () => {
            const d = r.result;
            for (const name of ['articles', 'kv', 'audio']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return p;
    }
    function req(store, mode, fn) {
      return open().then((d) => new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const q = fn(t.objectStore(store));
        t.oncomplete = () => res(q && q.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      })).catch(() => undefined);
    }
    return {
      get: (s, k) => req(s, 'readonly', (os) => os.get(k)),
      put: (s, k, v) => req(s, 'readwrite', (os) => os.put(v, k)),
      clear: (s) => req(s, 'readwrite', (os) => os.clear()),
    };
  })();

  /* ---------- State ---------- */
  const S = {
    pos: null, acc: null, fixTime: 0, source: 'gps', stopName: '',
    center: null, lastSortPos: null, loading: false, pending: false,
    radius: ls.get('radius', 805), read: new Set(ls.get('read', [])),
    seen: {}, fromCache: false, current: null,
  };

  async function fetchJSON(params, lang) {
    const api = 'https://' + (lang || 'en') + '.wikipedia.org/w/api.php';
    const url = api + '?' + new URLSearchParams(params).toString();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { headers: API_HEADERS, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const frEnabled = () => ls.get('fr', true);

  // English items keep the numeric page id as their key (so earlier saved data still matches).
  // French-only items are keyed "fr:<pageid>". French pages that have an English twin become
  // English items keyed "ent:<English title>" (deduplicated against English results by title).
  async function fetchNearby(lat, lon, radius, lang) {
    const params = {
      action: 'query', format: 'json', formatversion: '2', origin: '*',
      generator: 'geosearch', ggscoord: lat + '|' + lon,
      ggsradius: String(Math.min(10000, Math.round(radius))), ggslimit: '50', ggsnamespace: '0',
      prop: 'coordinates|description|pageimages', colimit: 'max',
      piprop: 'thumbnail', pithumbsize: '160', pilimit: 'max',
    };
    if (lang === 'fr') { params.prop += '|langlinks'; params.lllang = 'en'; params.lllimit = 'max'; }
    const r = await fetchJSON(params, lang);
    const pages = (r.query && r.query.pages) || [];
    return pages.filter((p) => p.coordinates && p.coordinates[0]).map((p) => {
      const base = { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon, thumb: (p.thumbnail && p.thumbnail.source) || null };
      if (lang !== 'fr') return { ...base, id: p.pageid, lang: 'en', title: p.title, desc: p.description || '' };
      const en = p.langlinks && p.langlinks[0] && (p.langlinks[0].title || p.langlinks[0]['*']);
      if (en) return { ...base, id: 'ent:' + en, lang: 'en', title: en, desc: '' };
      return { ...base, id: 'fr:' + p.pageid, lang: 'fr', pageid: p.pageid, title: p.title, desc: p.description || '' };
    });
  }

  async function fetchArticle(item) {
    const lang = item.lang || 'en';
    const params = {
      action: 'query', format: 'json', formatversion: '2', origin: '*', redirects: '1',
      prop: 'extracts|pageimages|description|coordinates|info',
      explaintext: '1', exsectionformat: 'wiki', piprop: 'thumbnail', pithumbsize: '800', inprop: 'url',
    };
    if (typeof item.id === 'number') params.pageids = String(item.id);
    else if (item.pageid) params.pageids = String(item.pageid);
    else params.titles = item.title;
    const r = await fetchJSON(params, lang);
    const p = r.query && r.query.pages && r.query.pages[0];
    if (!p || p.missing) throw new Error('missing');
    return {
      id: item.id, pageid: p.pageid, lang, title: p.title, desc: p.description || '', extract: p.extract || '',
      image: (p.thumbnail && p.thumbnail.source) || null,
      url: p.fullurl || ('https://' + lang + '.wikipedia.org/?curid=' + p.pageid),
      lat: p.coordinates && p.coordinates[0] ? p.coordinates[0].lat : null,
      lon: p.coordinates && p.coordinates[0] ? p.coordinates[0].lon : null,
      saved: Date.now(),
    };
  }

  /* --- Translation of French-only articles (OpenAI) --- */
  const TR_MODELS = ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
  const TR_PROMPT = 'Translate this French Wikipedia text into clear, natural English for travelers. ' +
    'Keep every line break. Lines that look like "== Heading ==" (any number of = signs) are section headings: ' +
    'translate the words and keep the = signs exactly. The first line starts with "# ": that is the title; keep the "# ". ' +
    'Keep proper names of places in French. Output only the translation.';
  async function chatTranslate(text) {
    const saved = ls.get('trModel', null);
    const models = saved ? [saved].concat(TR_MODELS.filter((m) => m !== saved)) : TR_MODELS;
    let lastErr;
    for (const model of models) {
      const body = { model, messages: [{ role: 'system', content: TR_PROMPT }, { role: 'user', content: text }] };
      if (model.startsWith('gpt-5')) body.reasoning_effort = 'minimal';
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 90000);
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', signal: ctl.signal,
          headers: { Authorization: 'Bearer ' + aiKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const j = await r.json();
          ls.set('trModel', model);
          return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        }
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) { /* ignore */ }
        const err = new Error(msg); err.status = r.status;
        if (r.status === 401 || r.status === 403 || r.status === 429) throw err;
        lastErr = err; // model not available etc.: try the next model
      } finally { clearTimeout(t); }
    }
    throw lastErr || new Error('No translation model available');
  }
  function blocksToText(blocks) {
    return blocks.map((b) => (b.type === 'h' ? '='.repeat(b.level) + ' ' + b.text + ' ' + '='.repeat(b.level) : b.text)).join('\n');
  }
  async function translateArticle(art, onProgress) {
    const blocks = W.parseExtract(art.extract);
    // Chunk by paragraphs (~5000 characters) and translate up to 4 chunks at a time.
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const b of blocks) {
      const t = blocksToText([b]);
      if (cur.length && len + t.length > 5000) { chunks.push(cur); cur = []; len = 0; }
      cur.push(b); len += t.length + 1;
    }
    if (cur.length || !chunks.length) chunks.push(cur);
    const out = new Array(chunks.length);
    let done = 0;
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const i = next++;
        const text = (i === 0 ? '# ' + art.title + '\n' : '') + blocksToText(chunks[i]);
        out[i] = await chatTranslate(text);
        done++;
        if (onProgress) onProgress(done, chunks.length);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()].slice(0, Math.min(4, chunks.length)));
    let all = out.join('\n');
    let title = art.title;
    const m = all.match(/^\s*#\s*(.+)\n?/);
    if (m) { title = m[1].trim(); all = all.slice(m[0].length); }
    return { title, extract: all, at: Date.now() };
  }

  /* ---------- Location ---------- */
  let watchId = null;
  function startGps() {
    S.source = 'gps';
    $('placePicker').classList.add('hidden');
    if (!('geolocation' in navigator)) { showPicker('This device has no location service. Browse from a stop instead:'); return; }
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    $('locStatus').innerHTML = 'Finding your location… · <button class="linkbtn" id="pickStopNow">Pick a stop</button>';
    $('pickStopNow').onclick = () => showPicker('Browse from a stop until GPS is available:');
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function onPos(p) {
    if (S.source !== 'gps') return;
    $('placePicker').classList.add('hidden');
    S.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
    S.acc = p.coords.accuracy;
    S.fixTime = Date.now();
    updateLocStatus();
    drawMe();
    maybeRefresh();
  }
  function onPosErr(e) {
    if (S.source !== 'gps') return;
    if (e.code === 1) {
      showPicker('Location is off for this app. Turn it on in iPhone Settings → Privacy & Security → Location Services (Safari Websites), or browse from a stop:');
    } else if (!S.pos) {
      showPicker("Can't get a GPS fix yet. Keep waiting, or browse from a stop:");
    }
  }
  function showPicker(msg) {
    $('placeMsg').textContent = msg;
    $('placePicker').classList.remove('hidden');
    if (!S.pos) $('locStatus').textContent = 'No location yet';
  }
  function useStop(id) {
    const st = W.STOPS.find((s) => s.id === id);
    if (!st) return;
    S.source = 'stop';
    S.stopName = st.name;
    S.pos = { lat: st.lat, lon: st.lon };
    S.acc = null;
    S.center = null;
    $('placePicker').classList.add('hidden');
    updateLocStatus();
    drawMe();
    centerMap();
    maybeRefresh();
  }
  function updateLocStatus() {
    const el = $('locStatus');
    if (!S.pos) return;
    if (S.source === 'stop') {
      el.innerHTML = 'Browsing from <b>' + esc(S.stopName) + '</b> · <button class="linkbtn" id="backToGps">Use GPS</button>';
      $('backToGps').onclick = startGps;
      return;
    }
    const secs = Math.round((Date.now() - S.fixTime) / 1000);
    const age = secs < 5 ? 'just now' : secs < 90 ? secs + ' s ago' : Math.round(secs / 60) + ' min ago';
    el.textContent = 'GPS ' + W.formatAccuracy(S.acc) + ' · ' + age;
  }
  setInterval(updateLocStatus, 10000);

  /* ---------- Nearby list ---------- */
  function maybeRefresh() {
    if (!S.pos) return;
    const moved = S.center ? W.distanceM(S.center.lat, S.center.lon, S.pos.lat, S.pos.lon) : Infinity;
    if (moved > S.radius * 0.33) { refresh(); return; }
    // Re-sort only after ~50 ft of movement so the list doesn't jump while reading.
    if (!S.lastSortPos || W.distanceM(S.lastSortPos.lat, S.lastSortPos.lon, S.pos.lat, S.pos.lon) > 15) render();
  }

  async function refresh() {
    if (S.loading) { S.pending = true; return; }
    S.loading = true;
    const at = { ...S.pos };
    S.center = at;
    if (!Object.keys(S.seen).length) render();
    const langs = frEnabled() ? ['en', 'fr'] : ['en'];
    const results = await Promise.allSettled(langs.map((l) => fetchNearby(at.lat, at.lon, S.radius, l)));
    let ok = false;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      ok = true;
      for (const p of r.value) S.seen[p.id] = p;
    }
    if (ok) { trimSeen(); db.put('kv', 'seen', S.seen); }
    S.fromCache = !ok; // offline or API trouble: use what's saved
    S.loading = false;
    updateNet();
    render();
    if (S.pending) { S.pending = false; maybeRefresh(); }
  }
  function trimSeen() {
    const ids = Object.keys(S.seen);
    if (ids.length <= 3000 || !S.pos) return;
    ids.map((id) => [id, W.distanceM(S.pos.lat, S.pos.lon, S.seen[id].lat, S.seen[id].lon)])
      .sort((a, b) => b[1] - a[1]).slice(0, ids.length - 3000).forEach(([id]) => delete S.seen[id]);
  }

  function currentItems() {
    if (!S.pos) return [];
    const fr = frEnabled();
    const byTitle = new Map();
    for (const p of Object.values(S.seen)) {
      if (p.lang === 'fr') { if (fr) byTitle.set('fr|' + p.id, p); continue; }
      const k = 'en|' + String(p.title).toLowerCase();
      const prev = byTitle.get(k);
      // Prefer the English result with a real page id over one found through French Wikipedia.
      if (!prev || (typeof prev.id !== 'number' && typeof p.id === 'number')) byTitle.set(k, p);
    }
    return [...byTitle.values()].map((p) => ({
      ...p,
      d: W.distanceM(S.pos.lat, S.pos.lon, p.lat, p.lon),
      b: W.bearingDeg(S.pos.lat, S.pos.lon, p.lat, p.lon),
    })).filter((p) => p.d <= S.radius * 1.05).sort((a, b) => a.d - b.d);
  }

  function render() {
    if (!S.pos) return;
    S.lastSortPos = { ...S.pos };
    const items = currentItems();
    drawPins(items);

    const ul = $('list');
    ul.textContent = '';
    for (const p of items) {
      const li = document.createElement('li');
      if (S.read.has(p.id)) li.classList.add('read');
      li.innerHTML =
        (p.thumb ? '<img class="thumb" loading="lazy" alt="" src="' + esc(p.thumb) + '">' : '<div class="thumb empty">◎</div>') +
        '<div class="li-main"><div class="li-title">' + (p.lang === 'fr' ? '<span class="frtag">FR</span>' : '') + esc(p.title) + '</div>' +
        (p.desc ? '<div class="li-desc">' + esc(p.desc) + '</div>' : '') +
        (S.read.has(p.id) ? '<div class="check">✓ read</div>' : '') + '</div>' +
        '<div class="li-dist">' + W.formatDist(p.d) + '<small>' + W.compass(p.b) + '</small></div>';
      const img = li.querySelector('img');
      if (img) img.onerror = () => { const d = document.createElement('div'); d.className = 'thumb empty'; d.textContent = '◎'; img.replaceWith(d); };
      li.onclick = () => openArticle(p);
      ul.appendChild(li);
    }
    const empty = $('listEmpty');
    if (items.length || view !== 'list') { empty.classList.add('hidden'); return; }
    empty.classList.remove('hidden');
    const r = $('radiusSel').selectedOptions[0].textContent;
    if (S.loading) empty.textContent = 'Looking for nearby articles…';
    else if (S.fromCache || !navigator.onLine) empty.textContent = "You're offline, and nothing is saved for this spot yet. Articles you've already opened still work.";
    else empty.textContent = 'No Wikipedia articles within ' + r + '. Try a bigger radius.';
  }

  /* ---------- Map ---------- */
  let map = null, meMarker = null, accCircle = null, pinLayer = null, follow = true, pinKey = '';
  let view = 'list';
  const zoomFor = (r) => (r <= 402 ? 17 : r <= 805 ? 16 : r <= 1609 ? 15 : 14);
  function setView(v) {
    view = v;
    $('tabList').classList.toggle('on', v === 'list');
    $('tabMap').classList.toggle('on', v === 'map');
    $('list').classList.toggle('hidden', v !== 'list');
    $('mapWrap').classList.toggle('hidden', v !== 'map');
    if (v === 'map') {
      $('listEmpty').classList.add('hidden');
      if (!window.L) { $('mapWrap').innerHTML = '<p class="muted center">The map could not load.</p>'; return; }
      initMap();
      setTimeout(() => { map.invalidateSize(); pinKey = ''; drawMe(); render(); centerMap(); }, 60);
    } else render();
    ls.set('view', v);
  }
  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, crossOrigin: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    map.on('dragstart', () => { follow = false; });
    if (S.pos) map.setView([S.pos.lat, S.pos.lon], zoomFor(S.radius));
    else map.setView([45.764, 4.8357], 13);
  }
  function centerMap() {
    if (!map || !S.pos) return;
    follow = true;
    map.setView([S.pos.lat, S.pos.lon], zoomFor(S.radius));
  }
  function drawMe() {
    if (!map || !S.pos) return;
    const ll = [S.pos.lat, S.pos.lon];
    if (!meMarker) {
      accCircle = L.circle(ll, { radius: S.acc || 0, weight: 1, color: '#2a7de1', fillOpacity: 0.08, interactive: false }).addTo(map);
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll); }
    accCircle.setRadius(S.source === 'gps' ? (S.acc || 0) : 0);
    if (follow && view === 'map') map.panTo(ll, { animate: true });
  }
  function drawPins(items) {
    if (!map || view !== 'map') return;
    const key = items.map((p) => p.id + (S.read.has(p.id) ? 'r' : '')).join(',');
    if (key === pinKey) return; // unchanged: keep open popups
    pinKey = key;
    pinLayer.clearLayers();
    for (const p of items) {
      const m = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: '<div class="pin' + (S.read.has(p.id) ? ' read' : '') + '"></div>', iconSize: [22, 22] }),
        title: p.title,
      });
      m.bindPopup(() => {
        const live = currentItems().find((x) => x.id === p.id) || p;
        const d = document.createElement('div');
        d.innerHTML = '<div class="popt">' + esc(p.title) + '</div><div class="popd">' + W.formatDist(live.d) + ' ' + W.compass(live.b) +
          (p.desc ? ' · ' + esc(p.desc) : '') + '</div><button class="popbtn">Open</button>';
        d.querySelector('button').onclick = () => { map.closePopup(); openArticle(p); };
        return d;
      });
      pinLayer.addLayer(m);
    }
  }
  $('tabList').onclick = () => setView('list');
  $('tabMap').onclick = () => setView('map');
  $('recenterBtn').onclick = centerMap;

  function updateNet() {
    const chip = $('netChip');
    const off = !navigator.onLine || S.fromCache;
    chip.textContent = off ? 'Offline · saved' : 'Live';
    chip.classList.toggle('off', off);
  }
  window.addEventListener('online', () => { updateNet(); S.center = null; maybeRefresh(); });
  window.addEventListener('offline', updateNet);

  /* ---------- Article view ---------- */
  function showSheet(id) {
    ['articleView', 'settingsView'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
    if (id) { document.body.dataset.sheet = id; history.pushState({ sheet: id }, ''); }
  }
  function closeSheets() {
    $('articleView').classList.add('hidden');
    $('settingsView').classList.add('hidden');
    delete document.body.dataset.sheet;
    S.current = null;
    S.curKey = null;
    if (map) setTimeout(() => map.invalidateSize(), 50);
    if (S.pos) maybeRefresh();
  }
  window.addEventListener('popstate', closeSheets);
  $('backBtn').onclick = () => history.back();
  $('settingsBack').onclick = () => history.back();

  function markRead(id) {
    if (S.read.has(id)) return;
    S.read.add(id);
    ls.set('read', [...S.read]);
  }

  async function openArticle(place) {
    S.current = place;
    S.curKey = null;
    showSheet('articleView');
    $('articleView').scrollTop = 0;
    const body = $('articleBody');
    body.innerHTML = '<h2>' + esc(place.title) + '</h2><p class="muted">Loading…</p>';
    markRead(place.id);
    let art = await db.get('articles', place.id);
    if (!art) {
      try {
        art = await fetchArticle(place);
        db.put('articles', place.id, art);
      } catch (e) {
        if (S.current !== place) return;
        body.innerHTML = '<h2>' + esc(place.title) + '</h2><p>' + esc(place.desc) + '</p>' +
          "<p class=\"muted\">This article isn't saved on this phone, and there's no connection right now. Try again when you have signal.</p>";
        return;
      }
    }
    if (S.current !== place) return;
    if (art.lang === 'fr' && !art.tr && aiKey() && navigator.onLine) { translateAndShow(art, place); return; }
    renderArticle(art, place);
  }

  async function translateAndShow(art, place) {
    const body = $('articleBody');
    body.innerHTML = '<h2>' + esc(art.title) + '</h2><p class="muted" id="trProg">Translating from French…</p>';
    try {
      art.tr = await translateArticle(art, (d, n) => { const el = $('trProg'); if (el && n > 1) el.textContent = 'Translating from French… ' + d + ' of ' + n; });
      db.put('articles', art.id, art);
    } catch (e) {
      art.trError = (e && (e.status === 401 || e.status === 403)) ? 'The OpenAI key was rejected for translation.'
        : (e && e.status === 429) ? 'The OpenAI account is out of credit or rate-limited.'
        : "Couldn't translate right now.";
    }
    if (S.current === place) renderArticle(art, place);
  }

  function renderArticle(art, place) {
    const tr = art.lang === 'fr' ? art.tr : null;
    const shownTitle = tr ? tr.title : art.title;
    const key = art.id + (tr ? ':tr' : '');
    const speakLang = art.lang === 'fr' && !tr ? 'fr' : 'en';
    const blocks = W.parseExtract(tr ? tr.extract : art.extract);
    S.curKey = key;
    if (!blocks.length && art.desc) blocks.push({ type: 'p', text: art.desc });
    const lat = art.lat != null ? art.lat : place.lat;
    const lon = art.lon != null ? art.lon : place.lon;
    let meta = '';
    if (S.pos && lat != null) {
      const d = W.distanceM(S.pos.lat, S.pos.lon, lat, lon);
      meta = W.formatDist(d) + ' ' + W.compass(W.bearingDeg(S.pos.lat, S.pos.lon, lat, lon));
    }
    if (art.desc && !tr) meta += (meta ? ' · ' : '') + art.desc;
    let h = '<h2>' + esc(shownTitle) + '</h2>';
    if (meta) h += '<div class="meta">' + esc(meta) + '</div>';
    if (art.lang === 'fr') {
      if (tr) h += '<div class="trnote">Translated from French Wikipedia by AI' + (shownTitle !== art.title ? ' (“' + esc(art.title) + '”)' : '') + '.</div>';
      else {
        h += '<div class="trnote">French Wikipedia article. ' + esc(art.trError || (aiKey() ? 'Not translated yet.' : 'Add an OpenAI key in Settings to translate it.')) + '</div>';
        if (aiKey()) h += '<button id="trBtn" class="btn secondary trbtn">Translate to English</button>';
      }
    }
    h += '<button id="artPlay" class="btn play">▶︎ Listen</button>';
    h += '<div class="voicenote">' + esc(P.art && P.art.key === key ? P.note : '') + '</div>';
    h += '<div class="actions">';
    if (lat != null) h += '<a class="btn secondary" href="https://maps.apple.com/?daddr=' + lat + ',' + lon + '&dirflg=w">Directions</a>';
    h += '<a class="btn secondary" href="' + esc(art.url) + '" target="_blank" rel="noopener">Wikipedia</a></div>';
    if (art.image) h += '<img class="lead-img" alt="" src="' + esc(art.image) + '" onerror="this.remove()">';
    blocks.forEach((b, i) => {
      if (b.type === 'h') { const tag = b.level <= 2 ? 'h3' : 'h4'; h += '<' + tag + ' data-block="' + i + '">' + esc(b.text) + '</' + tag + '>'; }
      else h += '<p data-block="' + i + '">' + esc(b.text) + '</p>';
    });
    h += '<p class="attrib">' + (tr ? 'AI translation of' : 'Text from') + ' the ' + (art.lang === 'fr' ? 'French ' : '') + 'Wikipedia article “<a href="' + esc(art.url) + '" target="_blank" rel="noopener">' + esc(art.title) +
      '</a>,” available under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>.</p>';
    const body = $('articleBody');
    body.innerHTML = h;
    const playBtn = $('artPlay');
    if (playBtn) playBtn.onclick = () => {
      if (P.art && P.art.key === key) { P.playing ? pause() : play(); }
      else {
        loadPlayer({ id: art.id, key, title: shownTitle, lang: speakLang, desc: art.desc, lat: art.lat, lon: art.lon, pageid: art.pageid, itemLang: art.lang }, blocks);
        play();
      }
    };
    const trBtn = $('trBtn');
    if (trBtn) trBtn.onclick = () => { delete art.trError; translateAndShow(art, place); };
    body.querySelectorAll('[data-block]').forEach((el) => {
      el.addEventListener('click', () => {
        if (!P.art || P.art.key !== key) return;
        jumpToBlock(+el.dataset.block);
      });
    });
    syncPlayerUI();
    if (P.art && P.art.key === key) highlight(currentBlock(), false);
  }

  /* ---------- Read-aloud ---------- */
  const synth = window.speechSynthesis;
  const RATES = [0.9, 1, 1.25];
  const P = { art: null, segs: [], i: 0, playing: false, token: 0, rate: ls.get('rate', 1), timer: null, engine: 'synth', aiUnit: null, note: '' };
  let voices = [];
  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    const sel = $('voiceSel');
    const en = voices.filter((v) => /^en[-_]/i.test(v.lang))
      .sort((a, b) => (a.lang + a.name).localeCompare(b.lang + b.name));
    const cur = W.pickVoice(voices, ls.get('voice', null));
    sel.innerHTML = en.map((v) => '<option value="' + esc(v.voiceURI) + '"' + (cur && cur.voiceURI === v.voiceURI ? ' selected' : '') + '>' +
      esc(v.name) + ' (' + esc(v.lang) + ')</option>').join('') || '<option>Default voice</option>';
  }
  if (synth) {
    loadVoices();
    if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices;
    setTimeout(loadVoices, 1000);
  }
  $('voiceSel').onchange = (e) => ls.set('voice', e.target.value);
  const voice = () => W.pickVoice(voices, ls.get('voice', null));
  const frVoice = () => {
    const fr = voices.filter((v) => /^fr[-_]FR/i.test(v.lang));
    const pool = fr.length ? fr : voices.filter((v) => /^fr/i.test(v.lang));
    const score = (v) => (/premium/i.test(v.name) ? 3 : 0) + (/enhanced/i.test(v.name) ? 2 : 0) + (v.localService ? 0.5 : 0);
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
  };

  /* --- AI voice (OpenAI) --- */
  const AI_URL = 'https://api.openai.com/v1/audio/speech';
  const AI_MODEL = 'gpt-4o-mini-tts';
  const AI_INSTR = 'Speak as a warm, knowledgeable walking-tour guide reading aloud to a family. ' +
    'Natural, unhurried pace with light expression. Pronounce French and other non-English names as a native speaker would.';
  const aiKey = () => String(ls.get('aiKey', '') || '').trim();
  const aiVoice = () => ls.get('aiVoice', 'coral');
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.setAttribute('playsinline', '');
  const inflight = {};
  // A tiny silent WAV, played inside a tap so iOS lets this audio element play later without a tap.
  const SILENT = (() => {
    const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    let bin = ''; new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
    return 'data:audio/wav;base64,' + btoa(bin);
  })();
  function unlockAudio() {
    try { audioEl.src = SILENT; audioEl.play().catch(() => {}); } catch (e) { /* ignore */ }
    if (synth) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch (e) { /* ignore */ } }
  }

  async function aiFetch(text) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(AI_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + aiKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, voice: aiVoice(), input: text, instructions: AI_INSTR, response_format: 'mp3' }),
      });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) { /* ignore */ }
        const err = new Error(msg); err.status = r.status; throw err;
      }
      return await r.blob();
    } finally { clearTimeout(t); }
  }

  // A unit = consecutive segments of the same paragraph, up to ~1500 characters (one AI request).
  function unitAt(i) {
    const first = P.segs[i];
    if (!first) return null;
    let j = i, text = first.text;
    while (j + 1 < P.segs.length && P.segs[j + 1].block === first.block && (text + ' ' + P.segs[j + 1].text).length <= 1500) {
      j++; text += ' ' + P.segs[j].text;
    }
    return { start: i, end: j, text, key: P.art.key + '|' + aiVoice() + '|' + i + '|' + j };
  }
  function getAudio(u) {
    if (inflight[u.key]) return inflight[u.key];
    const pr = (async () => {
      const hit = await db.get('audio', u.key);
      if (hit) return hit;
      const blob = await aiFetch(u.text);
      db.put('audio', u.key, blob);
      return blob;
    })();
    inflight[u.key] = pr;
    pr.catch(() => {}).finally(() => { delete inflight[u.key]; });
    return pr;
  }

  function aiFailed(e) {
    P.engine = 'synth';
    let msg = "Couldn't reach the AI voice, so the iPhone voice is reading instead.";
    if (e && (e.status === 401 || e.status === 403)) msg = 'The OpenAI key was rejected. Check it in Settings. Using the iPhone voice for now.';
    else if (e && e.status === 429) msg = 'The OpenAI account is out of credit or rate-limited. Using the iPhone voice for now.';
    showVoiceNote(msg);
  }
  function showVoiceNote(msg) {
    const el = document.querySelector('#articleBody .voicenote');
    if (el) el.textContent = msg || '';
    P.note = msg || '';
  }

  async function aiPlayCurrent() {
    const tok = ++P.token;
    const u = unitAt(P.i);
    if (!u) { finished(); return; }
    P.aiUnit = u;
    highlight(P.segs[u.start].block, true);
    let blob;
    try { blob = await getAudio(u); }
    catch (e) {
      if (tok !== P.token || !P.playing) return;
      aiFailed(e);
      speakCurrent();
      return;
    }
    if (tok !== P.token || !P.playing) return;
    if (audioEl._url) URL.revokeObjectURL(audioEl._url);
    audioEl._url = URL.createObjectURL(blob);
    audioEl.src = audioEl._url;
    audioEl.playbackRate = P.rate;
    audioEl.onended = () => { if (tok !== P.token || !P.playing) return; P.i = u.end + 1; aiPlayCurrent(); };
    audioEl.onerror = () => { if (tok !== P.token || !P.playing) return; P.i = u.end + 1; aiPlayCurrent(); };
    try { await audioEl.play(); }
    catch (e) { if (tok === P.token) { P.playing = false; syncPlayerUI(); } return; }
    // Fetch the next two pieces while this one plays.
    let n = u.end + 1;
    for (let k = 0; k < 2; k++) { const nu = unitAt(n); if (!nu) break; getAudio(nu).catch(() => {}); n = nu.end + 1; }
  }

  /* --- Player (shared by both engines) --- */
  function loadPlayer(art, blocks) {
    stop(true);
    P.art = art;
    P.segs = [{ block: -1, text: art.title + '.' }].concat(W.speechSegments(blocks));
    P.i = 0;
    P.aiUnit = null;
    $('player').classList.remove('hidden');
    $('plTitle').textContent = art.title;
    setMediaSession();
  }
  function currentBlock() { const s = P.segs[P.i]; return s ? s.block : -1; }

  function speakCurrent() {
    clearTimeout(P.timer);
    const seg = P.segs[P.i];
    if (!seg) { finished(); return; }
    const tok = ++P.token;
    const u = new SpeechSynthesisUtterance(seg.text);
    const v = P.art && P.art.lang === 'fr' ? frVoice() : voice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = P.art && P.art.lang === 'fr' ? 'fr-FR' : 'en-US';
    u.rate = P.rate;
    const advance = () => { if (tok !== P.token || !P.playing) return; P.i++; speakCurrent(); };
    u.onend = advance;
    u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled') return; advance(); };
    highlight(seg.block, true);
    synth.speak(u);
    // Watchdog: iOS sometimes never fires onend.
    const est = (seg.text.length / (14 * P.rate)) * 1000 + 4000;
    const check = () => {
      if (tok !== P.token || !P.playing) return;
      if (synth.speaking) { P.timer = setTimeout(check, 2000); return; }
      advance();
    };
    P.timer = setTimeout(check, est);
  }

  function silence() {
    P.token++;
    clearTimeout(P.timer);
    if (synth) synth.cancel();
    audioEl.pause();
  }
  // Start (or restart) output at P.i with the current engine.
  function go() {
    if (P.engine === 'ai') aiPlayCurrent();
    else speakCurrent();
  }

  function play() {
    if (!P.art) return;
    if (P.i >= P.segs.length) P.i = 0;
    // Resume an AI clip that was paused mid-way.
    if (P.engine === 'ai' && P.aiUnit && P.aiUnit.start === P.i && audioEl.src && !audioEl.ended && audioEl.currentTime > 0) {
      P.playing = true;
      audioEl.play().catch(() => { P.playing = false; syncPlayerUI(); });
      afterPlayStart();
      return;
    }
    P.engine = aiKey() ? 'ai' : 'synth';
    if (P.engine === 'synth' && !synth) return;
    if (P.engine === 'ai') unlockAudio();
    showVoiceNote('');
    P.playing = true;
    silence();
    if (P.engine === 'ai') audioEl.src = SILENT; // keep the element unlocked
    go();
    afterPlayStart();
  }
  function afterPlayStart() {
    wakeOn();
    syncPlayerUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }
  function pause() {
    P.playing = false;
    if (P.engine === 'ai') { P.token++; audioEl.pause(); if (synth) synth.cancel(); clearTimeout(P.timer); }
    else silence();
    wakeOff();
    syncPlayerUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
  function stop(keepHidden) {
    pause();
    P.art = null;
    P.segs = [];
    P.i = 0;
    P.aiUnit = null;
    clearHighlight();
    if (keepHidden !== true) $('player').classList.add('hidden');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }
  function finished() {
    P.playing = false;
    P.i = 0;
    P.aiUnit = null;
    clearHighlight();
    wakeOff();
    syncPlayerUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
  function moveTo(idx) {
    P.i = idx;
    P.aiUnit = null;
    if (P.playing) { silence(); go(); } else { silence(); highlight(currentBlock(), true); syncPlayerUI(); }
  }
  function jumpToBlock(block) {
    const idx = P.segs.findIndex((s) => s.block === block);
    if (idx >= 0) moveTo(idx);
  }
  function step(dir) {
    if (!P.art) return;
    const cur = currentBlock();
    let idx;
    if (dir > 0) idx = P.segs.findIndex((s) => s.block > cur);
    else {
      // go to start of current paragraph, or previous one if already at its start
      const start = P.segs.findIndex((s) => s.block === cur);
      const atStart = P.engine === 'ai' ? (P.aiUnit ? P.aiUnit.start === start && audioEl.currentTime < 2 : true) : P.i === start;
      const target = atStart ? (P.segs.slice(0, start).reverse().find(() => true) || P.segs[0]).block : cur;
      idx = P.segs.findIndex((s) => s.block === target);
    }
    if (idx >= 0) moveTo(idx);
  }
  function cycleRate() {
    const i = RATES.indexOf(P.rate);
    P.rate = RATES[(i + 1) % RATES.length];
    ls.set('rate', P.rate);
    syncPlayerUI();
    audioEl.playbackRate = P.rate;
    if (P.playing && P.engine !== 'ai') { silence(); go(); }
  }

  function setMediaSession() {
    if (!('mediaSession' in navigator) || !P.art) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: P.art.title, artist: 'Wiki Walk', album: 'Wikipedia',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.setActionHandler('play', () => play());
      navigator.mediaSession.setActionHandler('pause', () => pause());
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    } catch (e) { /* ignore */ }
  }

  function clearHighlight() { document.querySelectorAll('.speaking').forEach((el) => el.classList.remove('speaking')); }
  function highlight(block, scroll) {
    clearHighlight();
    if (!S.current || !P.art || S.curKey !== P.art.key || block < 0) return;
    const el = document.querySelector('#articleBody [data-block="' + block + '"]');
    if (!el) return;
    el.classList.add('speaking');
    if (scroll && !$('articleView').classList.contains('hidden')) {
      const r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 130) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function syncPlayerUI() {
    $('plPlay').textContent = P.playing ? '❚❚' : '▶︎';
    $('plPlay').setAttribute('aria-label', P.playing ? 'Pause' : 'Play');
    $('plRate').textContent = P.rate + '×';
    const ap = $('artPlay');
    if (ap && S.current) {
      const same = P.art && P.art.key === S.curKey;
      ap.textContent = same && P.playing ? '❚❚ Pause' : same && P.i > 0 ? '▶︎ Resume' : '▶︎ Listen';
    }
  }

  $('plPlay').onclick = () => (P.playing ? pause() : play());
  $('plPrev').onclick = () => step(-1);
  $('plNext').onclick = () => step(1);
  $('plRate').onclick = cycleRate;
  $('plStop').onclick = () => stop();
  $('plTitle').onclick = () => {
    if (!P.art) return;
    if (S.current && S.current.id === P.art.id) return;
    openArticle({ id: P.art.id, lang: P.art.itemLang || 'en', pageid: P.art.pageid, title: P.art.title, desc: P.art.desc, lat: P.art.lat, lon: P.art.lon });
  };

  /* Screen wake lock */
  let wl = null;
  async function wakeOn() {
    if (!ls.get('wake', true) || !('wakeLock' in navigator)) return;
    try { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } catch (e) { wl = null; }
  }
  function wakeOff() { if (wl) { wl.release().catch(() => {}); wl = null; } }
  document.addEventListener('visibilitychange', () => {
    // iOS stops the iPhone voice when the app goes to the background or the screen locks; pause so Resume picks up here.
    // The AI voice is regular audio, so it is left playing.
    if (document.visibilityState === 'hidden' && P.playing && P.engine !== 'ai') pause();
    if (document.visibilityState === 'visible' && P.playing) wakeOn();
  });

  /* ---------- Settings ---------- */
  $('settingsBtn').onclick = async () => {
    showSheet('settingsView');
    $('wakeChk').checked = ls.get('wake', true);
    $('frChk').checked = frEnabled();
    $('aiKey').value = aiKey();
    $('aiVoiceSel').value = aiVoice();
    loadVoices();
    $('versionInfo').textContent = 'Version ' + VERSION + ('wakeLock' in navigator ? '' : ' · Keep-screen-on is not supported on this iOS version.');
    const info = $('storageInfo');
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const per = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      info.textContent = (est ? 'Saved on this phone: ' + (est.usage / 1048576).toFixed(1) + ' MB. ' : '') +
        (per ? 'Storage is protected from automatic cleanup.' : 'Storage may be cleared by iOS if the app goes unused.');
    } catch (e) { info.textContent = ''; }
  };
  $('wakeChk').onchange = (e) => ls.set('wake', e.target.checked);
  $('frChk').onchange = (e) => { ls.set('fr', e.target.checked); S.center = null; pinKey = ''; render(); };
  $('aiKey').onchange = (e) => { ls.set('aiKey', e.target.value.trim()); $('aiStatus').textContent = e.target.value.trim() ? 'Key saved on this phone. Tap Test AI voice.' : 'No key: the iPhone voice will read.'; };
  $('aiVoiceSel').onchange = (e) => ls.set('aiVoice', e.target.value);
  $('testAiBtn').onclick = async () => {
    const st = $('aiStatus');
    const typed = $('aiKey').value.trim();
    if (typed !== aiKey()) ls.set('aiKey', typed);
    if (!aiKey()) { st.textContent = 'Paste your OpenAI key above first.'; return; }
    if (P.playing) pause();
    unlockAudio();
    st.textContent = 'Testing…';
    try {
      const b = await aiFetch('Bonjour! This is your Wiki Walk guide. Our next stop is the Hospices de Beaune.');
      if (audioEl._url) URL.revokeObjectURL(audioEl._url);
      audioEl._url = URL.createObjectURL(b);
      audioEl.src = audioEl._url;
      audioEl.playbackRate = 1;
      audioEl.onended = null; audioEl.onerror = null;
      await audioEl.play();
      st.textContent = 'Working. This voice reads articles when you have signal, and replays saved ones offline.';
    } catch (e) {
      st.textContent = (e.status === 401 || e.status === 403) ? 'That key was rejected. Check it was copied in full.'
        : e.status === 429 ? 'This OpenAI account has no credit or hit a limit.'
        : e.name === 'NotAllowedError' ? 'Audio was blocked. Tap Test AI voice again.'
        : "Couldn't reach OpenAI (" + e.message + '). Check your connection.';
    }
  };
  $('clearAudioBtn').onclick = async () => { await db.clear('audio'); $('aiStatus').textContent = 'Saved AI audio deleted.'; };
  $('testVoiceBtn').onclick = () => {
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance('This is how articles will sound on your walk.');
    const v = voice(); if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = P.rate;
    synth.speak(u);
  };
  $('clearReadBtn').onclick = () => { S.read.clear(); ls.set('read', []); };

  /* Text size */
  function applyFs(px) { document.documentElement.style.setProperty('--fs', px + 'px'); ls.set('fs', px); }
  applyFs(ls.get('fs', 19));
  $('textSmaller').onclick = () => applyFs(Math.max(15, ls.get('fs', 19) - 2));
  $('textLarger').onclick = () => applyFs(Math.min(27, ls.get('fs', 19) + 2));

  /* Radius */
  const rs = $('radiusSel');
  rs.value = String(S.radius);
  if (!rs.value) { rs.value = '805'; S.radius = 805; }
  rs.onchange = () => { S.radius = +rs.value; ls.set('radius', S.radius); S.center = null; pinKey = ''; maybeRefresh(); render(); centerMap(); };

  /* Stop picker */
  $('placeSel').innerHTML = '<option value="">Choose a stop…</option>' +
    W.STOPS.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
  $('placeSel').onchange = (e) => { if (e.target.value) useStop(e.target.value); };
  $('useGpsBtn').onclick = startGps;

  /* Install hint + banners */
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !standalone && !ls.get('hintDismissed', false)) $('installHint').classList.remove('hidden');
  document.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.onclick = () => { $(b.dataset.dismiss).classList.add('hidden'); ls.set('hintDismissed', true); };
  });
  if (standalone && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* Service worker + updates */
  if ('serviceWorker' in navigator) {
    let reloading = false;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const showUpdate = () => $('updateBanner').classList.remove('hidden');
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
      });
      $('updateBtn').onclick = () => { reloading = true; if (reg.waiting) reg.waiting.postMessage('skipWaiting'); else location.reload(); };
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  }

  /* ---------- Start ---------- */
  history.replaceState({ sheet: null }, '');
  updateNet();
  db.get('kv', 'seen').then((seen) => {
    if (seen && typeof seen === 'object') S.seen = Object.assign(seen, S.seen);
    if (S.pos) render();
  });
  startGps();
})();
