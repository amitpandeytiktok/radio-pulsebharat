/* Pulse Bharat Radio — continuous Hindi-RJ tech & AI stream.
   Fetches the program manifest, plays segments back-to-back, loops forever,
   and quietly swaps in a fresher program whenever the newsroom updates. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var audio = $('audio');
  var preloadEl = new Audio();
  preloadEl.preload = 'auto';

  var state = {
    program: null,
    segs: [],
    idx: 0,
    started: false,
    pending: null,         // a fresher program waiting to be adopted at loop end
    errStreak: 0,
  };

  var CAT = {
    good:    { hi: 'अच्छी खबर', cls: 'good' },
    bad:     { hi: 'चिंता',     cls: 'bad' },
    ugly:    { hi: 'गंभीर',     cls: 'ugly' },
    station: { hi: 'स्टेशन',    cls: 'station' },
  };

  /* ---------------- data ---------------- */

  function fetchProgram(silent) {
    return fetch('/api/playlist', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (p) {
        if (!p || !Array.isArray(p.segments) || !p.segments.length) throw new Error('empty program');
        if (silent && state.started) {
          // Adopt at the next natural loop boundary so we never cut a segment.
          if (!state.program || p.updatedAt !== state.program.updatedAt) {
            state.pending = p;
            toast('नया प्रसारण तैयार — अगले राउंड में।');
          }
        } else {
          adopt(p, 0);
        }
        return p;
      });
  }

  function adopt(p, idx) {
    state.program = p;
    state.segs = p.segments;
    state.idx = idx || 0;
    renderMeta();
    renderQueue();
  }

  /* ---------------- playback ---------------- */

  function current() { return state.segs[state.idx] || null; }

  function playAt(i) {
    if (!state.segs.length) return;
    state.idx = ((i % state.segs.length) + state.segs.length) % state.segs.length;
    var seg = current();
    if (!seg || !seg.audio) { advance(); return; }
    audio.src = seg.audio;
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () {/* autoplay gesture / network */});
    renderNowPlaying(seg);
    renderQueue();
    preloadNext();
  }

  function advance() {
    var next = state.idx + 1;
    if (next >= state.segs.length) {
      // Loop point — adopt a fresher program if one arrived, else pull one
      // roughly hourly so a long-lived tab doesn't drift stale.
      if (state.pending) { adopt(state.pending, 0); state.pending = null; }
      else if (shouldReheat()) { fetchProgram(true).catch(function () {}); }
      next = 0;
    }
    playAt(next);
  }

  var lastHeat = Date.now();
  function shouldReheat() {
    if (Date.now() - lastHeat < 18 * 60 * 1000) return false;
    lastHeat = Date.now();
    return true;
  }

  function preloadNext() {
    var n = state.segs[(state.idx + 1) % state.segs.length];
    if (n && n.audio) { try { preloadEl.src = n.audio; preloadEl.load(); } catch (e) {} }
  }

  function togglePlay() {
    if (!state.started) { start(); return; }
    if (audio.paused) { audio.play().catch(function () {}); }
    else { audio.pause(); }
  }

  function start() {
    if (state.started) { audio.play().catch(function () {}); return; }
    state.started = true;
    $('gate').classList.add('hidden');
    if (!state.segs.length) {
      fetchProgram(false).then(function () { playAt(0); }).catch(function (e) { gateError(e); });
    } else {
      playAt(state.idx);
    }
  }

  /* ---------------- render ---------------- */

  function renderNowPlaying(seg) {
    var cat = CAT[seg.kind === 'story' ? (seg.cat || 'station') : 'station'];
    var tag = $('npTag');
    tag.className = 'tag ' + cat.cls;
    tag.textContent = seg.kind === 'story' ? cat.hi : (state.program ? state.program.station : 'Pulse Bharat Radio');

    $('npBeat').textContent = seg.beat ? seg.beat.toUpperCase() : '';

    if (seg.kind === 'story') {
      $('npHi').textContent = seg.titleHi || seg.title || '—';
      $('npEn').textContent = seg.titleHi && seg.title ? seg.title : '';
    } else {
      $('npHi').textContent = (state.program && state.program.tagline) || 'Pulse Bharat Radio';
      $('npEn').textContent = '';
    }

    var src = $('npSrc');
    src.innerHTML = '';
    if (seg.kind === 'story' && seg.source) {
      var s = document.createElement('span');
      s.innerHTML = 'स्रोत · <span class="src"></span>';
      s.querySelector('.src').textContent = seg.source;
      src.appendChild(s);
    }
    if (seg.kind === 'story' && seg.link) {
      var a = document.createElement('a');
      a.className = 'readlink'; a.href = seg.link; a.target = '_blank'; a.rel = 'noopener';
      a.innerHTML = 'पूरी खबर पढ़ें <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14zM5 5h5v2H7v10h10v-3h2v5H5z"/></svg>';
      src.appendChild(a);
    }

    var cap = $('npCaption');
    if (seg.text) { cap.hidden = false; cap.textContent = '“' + seg.text + '”'; }
    else { cap.hidden = true; }

    document.title = (seg.kind === 'story' && (seg.titleHi || seg.title) ? (seg.titleHi || seg.title) + ' · ' : '') + 'Pulse Bharat Radio';
  }

  function fmtDur(ms) {
    var s = Math.round((ms || 0) / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function renderMeta() {
    var p = state.program; if (!p) return;
    $('metaVoice').textContent = (p.voice || '').replace('Neural', '').replace('hi-IN-', '') || '—';
    $('metaCount').textContent = p.count || p.segments.length;
    $('metaUpdated').innerHTML = 'अपडेटेड <b>' + relTime(p.updatedAt) + '</b>';
  }

  function renderQueue() {
    var q = $('queue'); if (!q) return;
    q.innerHTML = '';
    var n = state.segs.length;
    var show = Math.min(n, 9);
    for (var k = 0; k < show; k++) {
      var i = (state.idx + k) % n;
      var seg = state.segs[i];
      var cat = CAT[seg.kind === 'story' ? (seg.cat || 'station') : 'station'];
      var row = document.createElement('div');
      row.className = 'q' + (k === 0 ? ' now' : '');
      row.setAttribute('data-i', i);
      var label = seg.kind === 'story' ? (seg.titleHi || seg.title || 'खबर')
        : (seg.kind === 'ident' ? 'स्टेशन आईडी' : seg.kind === 'signoff' ? 'समापन' : 'बीच का ब्रेक');
      var sub = seg.kind === 'story' ? (seg.source || (cat.hi)) : 'Pulse Bharat Radio';
      row.innerHTML =
        '<span class="num">' + (k === 0 ? '▶' : k) + '</span>' +
        '<span class="pip ' + cat.cls + '"></span>' +
        '<span class="qbody"><div class="qhi"></div><div class="qsub"></div></span>' +
        '<span class="qd">' + fmtDur(seg.durationMs) + '</span>';
      row.querySelector('.qhi').textContent = label;
      row.querySelector('.qsub').textContent = sub;
      row.addEventListener('click', function () {
        var ti = parseInt(this.getAttribute('data-i'), 10);
        if (!state.started) start();
        playAt(ti);
      });
      q.appendChild(row);
    }
    $('queueLen').textContent = n + ' सेगमेंट · ' + fmtDur(state.program ? state.program.totalDurationMs : 0);
  }

  function setOnAir(on) {
    var el = $('onair');
    el.classList.toggle('off', !on);
    $('onairText').textContent = on ? 'ON AIR' : 'PAUSED';
    $('eq').classList.toggle('playing', on);
    $('playIcon').setAttribute('d', on ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M8 5v14l11-7z');
  }

  function relTime(iso) {
    if (!iso) return 'अभी';
    var d = Date.now() - new Date(iso).getTime();
    var m = Math.round(d / 60000);
    if (m < 1) return 'अभी-अभी';
    if (m < 60) return m + ' मिनट पहले';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' घंटे पहले';
    return Math.round(h / 24) + ' दिन पहले';
  }

  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function gateError(e) {
    state.started = false;
    $('gate').classList.remove('hidden');
    $('gateHint').textContent = 'प्रोग्राम लोड नहीं हो पाया। दोबारा कोशिश करें।';
    console.warn('program load failed', e);
  }

  /* ---------------- audio events ---------------- */

  audio.addEventListener('playing', function () { setOnAir(true); state.errStreak = 0; });
  audio.addEventListener('pause', function () { if (!audio.ended) setOnAir(false); });
  audio.addEventListener('ended', function () { advance(); });
  audio.addEventListener('error', function () {
    state.errStreak++;
    if (state.errStreak > state.segs.length + 2) { toast('ऑडियो में दिक्कत — दोबारा जोड़ रहे हैं…'); state.errStreak = 0; setTimeout(function () { fetchProgram(false).then(function () { playAt(0); }).catch(function () {}); }, 4000); return; }
    setTimeout(advance, 600);
  });
  audio.addEventListener('timeupdate', function () {
    var d = audio.duration || 0;
    $('scrub').style.width = d ? Math.min(100, (audio.currentTime / d) * 100) + '%' : '0%';
  });

  /* ---------------- controls ---------------- */

  $('tuneBtn').addEventListener('click', start);
  $('playBtn').addEventListener('click', togglePlay);
  $('nextBtn').addEventListener('click', function () { if (!state.started) start(); else advance(); });
  $('prevBtn').addEventListener('click', function () { if (!state.started) start(); else playAt(state.idx - 1); });
  $('vol').addEventListener('input', function () { audio.volume = parseFloat(this.value); });
  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') { if (state.started) advance(); }
    else if (e.code === 'ArrowLeft') { if (state.started) playAt(state.idx - 1); }
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', start);
      navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { if (state.started) advance(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { if (state.started) playAt(state.idx - 1); });
    } catch (e) {}
  }

  /* ---------------- boot ---------------- */

  fetchProgram(false)
    .then(function () { $('gateHint').textContent = 'तैयार — सुनना शुरू करें ▸'; })
    .catch(function (e) { $('gateHint').textContent = 'प्रोग्राम लोड हो रहा है… कुछ सेकंड दें।'; setTimeout(function () { fetchProgram(false).catch(function () {}); }, 8000); });

  // Keep the manifest meta fresh even before playback starts.
  setInterval(function () { if (state.started) fetchProgram(true).catch(function () {}); }, 20 * 60 * 1000);
})();
