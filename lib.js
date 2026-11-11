/* Pure helpers (no DOM). Loaded in the browser as a script; also testable in Node. */
(function (root) {
  const STOPS = [
    { id: 'avignon', name: 'Avignon', lat: 43.9493, lon: 4.8055 },
    { id: 'viviers', name: 'Viviers', lat: 44.4823, lon: 4.6889 },
    { id: 'tain', name: "Tain-l'Hermitage / Tournon", lat: 45.0700, lon: 4.8400 },
    { id: 'lyon', name: 'Lyon', lat: 45.7640, lon: 4.8357 },
    { id: 'tournus', name: 'Tournus', lat: 46.5627, lon: 4.9096 },
    { id: 'chalon', name: 'Chalon-sur-Saône', lat: 46.7808, lon: 4.8536 },
    { id: 'beaune', name: 'Beaune', lat: 47.0260, lon: 4.8400 },
  ];

  const R = 6371008.8; // meters
  const rad = (d) => (d * Math.PI) / 180;

  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
      Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function compass(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  const FT_PER_M = 3.28084;
  function formatDist(m) {
    const ft = m * FT_PER_M;
    if (ft < 528) { // under 0.1 mi
      const r = ft < 100 ? Math.max(10, Math.round(ft / 10) * 10) : Math.round(ft / 25) * 25;
      return r + ' ft';
    }
    const mi = ft / 5280;
    return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }

  function formatAccuracy(m) {
    return '±' + Math.max(5, Math.round((m * FT_PER_M) / 5) * 5) + ' ft';
  }

  const SKIP_SECTIONS = /^(see also|references|external links|notes|further reading|bibliography|sources|citations|footnotes|notes and references|references and notes|gallery|works cited|literature)$/i;

  /**
   * Parse a TextExtracts plain-text extract (exsectionformat=wiki) into blocks.
   * Returns [{type:'h', level, text} | {type:'p', text}], skipping reference-type sections.
   */
  function parseExtract(text) {
    const out = [];
    let skipLevel = 0; // when >0, skipping until a heading with level <= skipLevel
    const lines = (text || '').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(={2,6})\s*(.*?)\s*\1$/);
      if (m) {
        const level = m[1].length;
        const title = m[2];
        if (skipLevel && level > skipLevel) continue;
        skipLevel = 0;
        if (SKIP_SECTIONS.test(title)) { skipLevel = level; continue; }
        out.push({ type: 'h', level, text: title });
        continue;
      }
      if (skipLevel) continue;
      out.push({ type: 'p', text: line });
    }
    // Drop headings that ended up with no content under them.
    const cleaned = [];
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (b.type === 'h') {
        // keep a heading only if the next block is a paragraph or a deeper heading
        const next = out[i + 1];
        if (!next || (next.type === 'h' && next.level <= b.level)) continue;
      }
      cleaned.push(b);
    }
    return cleaned;
  }

  /**
   * Turn blocks into speech segments. Each block gets an index; long paragraphs are split
   * into sentence groups of about maxLen characters so iOS doesn't cut them off.
   */
  function speechSegments(blocks, maxLen) {
    maxLen = maxLen || 280;
    const segs = [];
    blocks.forEach((b, idx) => {
      if (b.type === 'h') { segs.push({ block: idx, text: b.text + '.' }); return; }
      const sentences = b.text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*\s*|$)/g) || [b.text];
      let cur = '';
      for (const s of sentences) {
        if (cur && (cur + s).length > maxLen) { segs.push({ block: idx, text: cur.trim() }); cur = ''; }
        cur += s;
        while (cur.length > maxLen * 1.25) { // a single very long sentence: split on commas/spaces
          let cut = cur.lastIndexOf(', ', maxLen);
          if (cut < maxLen / 2) cut = cur.lastIndexOf(' ', maxLen);
          if (cut < 1) cut = maxLen;
          segs.push({ block: idx, text: cur.slice(0, cut + 1).trim() });
          cur = cur.slice(cut + 1);
        }
      }
      if (cur.trim()) segs.push({ block: idx, text: cur.trim() });
    });
    return segs;
  }

  /** Choose a default English voice: prefer en-US Premium/Enhanced, then known good ones. */
  function pickVoice(voices, preferredURI) {
    if (preferredURI) {
      const v = voices.find((x) => x.voiceURI === preferredURI);
      if (v) return v;
    }
    const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
    const us = en.filter((v) => /en[-_]US/i.test(v.lang));
    const score = (v) => (/premium/i.test(v.name) ? 3 : 0) + (/enhanced/i.test(v.name) ? 2 : 0) +
      (/^(samantha|ava|zoe|evan|nathan|allison|tom)/i.test(v.name) ? 1 : 0) + (v.localService ? 0.5 : 0);
    const pool = us.length ? us : en;
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || voices[0] || null;
  }

  const api = { STOPS, distanceM, bearingDeg, compass, formatDist, formatAccuracy, parseExtract, speechSegments, pickVoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WW = api;
})(typeof self !== 'undefined' ? self : this);
