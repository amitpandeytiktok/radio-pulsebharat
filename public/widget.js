/* Higgsfield-style embeddable radio widget.
 *
 * Drop-in: any page can add a floating "Listen Live" mini-player for this
 * station with a single tag — no other markup, no config:
 *
 *   <script src="https://radio.themudda.com/widget.js" defer></script>
 *
 * The widget derives the station origin from its own <script src>, so the same
 * file works for every station and always streams the right one. It fetches
 * <origin>/api/playlist (already CORS-open), plays the segments back-to-back in
 * an isolated Shadow DOM (so it can never clash with the host page's CSS), loops
 * forever, and quietly adopts a fresher program at each loop boundary.
 *
 * Optional <script> attributes:
 *   data-accent="#e8462a"   accent colour (defaults per the page if omitted)
 *   data-label="Listen Live" launcher label
 *   data-position="left"    dock bottom-left instead of bottom-right
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  var RADIO = '';
  try { RADIO = new URL(script.src).origin; } catch (e) { return; }
  if (!RADIO || window.__hfRadioWidget) return;
  window.__hfRadioWidget = true;

  var ACCENT = script.getAttribute('data-accent') || '#e8462a';
  var LABEL = script.getAttribute('data-label') || 'Listen Live';
  var SIDE = (script.getAttribute('data-position') === 'left') ? 'left' : 'right';
  var HIDE_KEY = 'hfRadioHidden:' + RADIO;

  function abs(u) { return /^https?:/.test(u || '') ? u : RADIO + (u || ''); }

  /* ------------------------------------------------------------------ shell */
  var host = document.createElement('div');
  host.id = 'hf-radio-widget';
  (document.body || document.documentElement).appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var css =
    ':host{all:initial}' +
    '*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}' +
    '.wrap{position:fixed;bottom:18px;' + SIDE + ':18px;z-index:2147483000}' +
    '.btn,.card{box-shadow:0 10px 30px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.18)}' +
    '.btn{display:flex;align-items:center;gap:9px;background:#15161a;color:#fff;border:0;cursor:pointer;' +
      'padding:11px 16px 11px 13px;border-radius:999px;font-size:14px;font-weight:650;letter-spacing:.2px;' +
      'transition:transform .15s ease,box-shadow .15s ease}' +
    '.btn:hover{transform:translateY(-1px)}' +
    '.btn .dot{width:9px;height:9px;border-radius:50%;background:' + ACCENT + ';box-shadow:0 0 0 0 ' + ACCENT + ';animation:pulse 2s infinite}' +
    '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(232,70,42,.5)}70%{box-shadow:0 0 0 8px rgba(232,70,42,0)}100%{box-shadow:0 0 0 0 rgba(232,70,42,0)}}' +
    '.card{width:320px;max-width:calc(100vw - 36px);background:#15161a;color:#fff;border-radius:16px;overflow:hidden;display:none}' +
    '.card.open{display:block}' +
    '.hd{display:flex;align-items:center;gap:8px;padding:12px 12px 10px}' +
    '.hd .live{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:1.3px;color:' + ACCENT + '}' +
    '.hd .live .dot{width:8px;height:8px;border-radius:50%;background:' + ACCENT + ';animation:pulse 2s infinite}' +
    '.hd .stn{font-size:12px;color:#aeb2bb;font-weight:600;margin-' + (SIDE === 'left' ? 'left' : 'right') + ':auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}' +
    '.icbtn{background:transparent;border:0;color:#9aa0ab;cursor:pointer;padding:4px;border-radius:8px;line-height:0}' +
    '.icbtn:hover{color:#fff;background:rgba(255,255,255,.08)}' +
    '.bd{padding:4px 14px 12px}' +
    '.tag{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.1);color:#cfd3da;margin-bottom:8px}' +
    '.tag.accent{background:' + ACCENT + ';color:#fff}' +
    '.np{font-size:15px;line-height:1.34;font-weight:600;max-height:4.1em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}' +
    'a.np{color:#fff;text-decoration:none}a.np:hover{text-decoration:underline}' +
    '.sub{margin-top:5px;font-size:12px;color:#9aa0ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.bar{height:3px;background:rgba(255,255,255,.12);border-radius:3px;margin:11px 0 10px;overflow:hidden}' +
    '.bar>i{display:block;height:100%;width:0;background:' + ACCENT + ';transition:width .25s linear}' +
    '.ctl{display:flex;align-items:center;gap:6px}' +
    '.play{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;background:' + ACCENT + ';color:#fff;border:0;cursor:pointer;flex:0 0 auto}' +
    '.play:hover{filter:brightness(1.08)}' +
    '.skip{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.08);color:#fff;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.skip:hover{background:rgba(255,255,255,.16)}' +
    '.vol{margin-left:auto;width:78px;accent-color:' + ACCENT + '}' +
    '.full{display:block;margin-top:11px;font-size:11.5px;color:#9aa0ab;text-decoration:none;text-align:center}' +
    '.full:hover{color:#fff}' +
    '.eq{display:inline-flex;align-items:flex-end;gap:2px;height:11px}' +
    '.eq i{width:2px;background:' + ACCENT + ';height:30%}' +
    '.eq.on i{animation:eq .9s ease-in-out infinite}' +
    '.eq i:nth-child(2){animation-delay:.15s}.eq i:nth-child(3){animation-delay:.3s}.eq i:nth-child(4){animation-delay:.45s}' +
    '@keyframes eq{0%,100%{height:30%}50%{height:100%}}';

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="wrap">' +
      '<button class="btn" id="launch" aria-label="' + LABEL + '"><span class="dot"></span><span>' + LABEL + '</span></button>' +
      '<div class="card" id="card" role="dialog" aria-label="Radio player">' +
        '<div class="hd">' +
          '<span class="live"><span class="dot"></span>ON AIR <span class="eq" id="eq"><i></i><i></i><i></i><i></i></span></span>' +
          '<span class="stn" id="stn">Radio</span>' +
          '<button class="icbtn" id="min" title="Minimise" aria-label="Minimise"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg></button>' +
          '<button class="icbtn" id="close" title="Close" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '</div>' +
        '<div class="bd">' +
          '<span class="tag" id="tag">STATION</span>' +
          '<div id="npWrap"><div class="np" id="np">…</div></div>' +
          '<div class="sub" id="sub"></div>' +
          '<div class="bar"><i id="prog"></i></div>' +
          '<div class="ctl">' +
            '<button class="play" id="play" aria-label="Play/Pause"><svg id="playIc" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
            '<button class="skip" id="next" aria-label="Next" title="Next"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>' +
            '<input class="vol" id="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">' +
          '</div>' +
          '<a class="full" id="full" href="' + RADIO + '" target="_blank" rel="noopener">Open the full station ↗</a>' +
        '</div>' +
      '</div>' +
    '</div>';

  var $ = function (id) { return root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); };
  var audio = new Audio();
  audio.preload = 'auto';
  var pre = new Audio(); pre.preload = 'auto';

  var st = { segs: [], idx: 0, program: null, started: false, pending: null, errs: 0 };
  var lastHeat = Date.now();

  /* -------------------------------------------------------------- data */
  function load(silent) {
    return fetch(RADIO + '/api/playlist', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (p) {
        if (!p || !Array.isArray(p.segments) || !p.segments.length) throw new Error('empty');
        if (silent && st.started) {
          if (!st.program || p.updatedAt !== st.program.updatedAt) st.pending = p;
        } else { adopt(p, 0); }
        if (p.station) $('stn').textContent = p.station;
        return p;
      });
  }
  function adopt(p, i) { st.program = p; st.segs = p.segments; st.idx = i || 0; }

  /* ----------------------------------------------------------- playback */
  function cur() { return st.segs[st.idx] || null; }
  function playAt(i) {
    if (!st.segs.length) return;
    st.idx = ((i % st.segs.length) + st.segs.length) % st.segs.length;
    var s = cur();
    if (!s || !s.audio) { advance(); return; }
    audio.src = abs(s.audio);
    var pr = audio.play(); if (pr && pr.catch) pr.catch(function () {});
    render(s); preloadNext();
  }
  function advance() {
    var n = st.idx + 1;
    if (n >= st.segs.length) {
      if (st.pending) { adopt(st.pending, 0); st.pending = null; }
      else if (Date.now() - lastHeat > 18 * 60000) { lastHeat = Date.now(); load(true).catch(function () {}); }
      n = 0;
    }
    playAt(n);
  }
  function preloadNext() {
    var n = st.segs[(st.idx + 1) % st.segs.length];
    if (n && n.audio) { try { pre.src = abs(n.audio); pre.load(); } catch (e) {} }
  }
  function start() {
    if (st.started) { audio.play().catch(function () {}); return; }
    st.started = true;
    if (!st.segs.length) load(false).then(function () { playAt(0); }).catch(function () {});
    else playAt(st.idx);
  }
  function toggle() {
    if (!st.started) { start(); return; }
    if (audio.paused) audio.play().catch(function () {}); else audio.pause();
  }

  /* ------------------------------------------------------------- render */
  function render(s) {
    var isStory = s.kind === 'story';
    var tag = $('tag');
    tag.textContent = isStory ? (s.beat || (st.program && st.program.station) || 'NEWS') : (st.program && st.program.station) || 'STATION';
    tag.className = 'tag' + (isStory ? ' accent' : '');
    var title = isStory ? (s.titleHi || s.title || '—') : ((st.program && st.program.tagline) || (st.program && st.program.station) || '');
    var wrap = $('npWrap');
    if (isStory && s.link) {
      wrap.innerHTML = '<a class="np" target="_blank" rel="noopener"></a>';
      var a = wrap.firstChild; a.href = s.link; a.textContent = title;
    } else {
      wrap.innerHTML = '<div class="np"></div>';
      wrap.firstChild.textContent = title;
    }
    $('sub').textContent = isStory ? (s.source ? 'स्रोत · ' + s.source : '') : '';
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title,
          artist: (st.program && st.program.station) || 'Radio',
          album: (st.program && st.program.tagline) || ''
        });
      } catch (e) {}
    }
  }
  function setOn(on) {
    $('eq').classList.toggle('on', on);
    $('playIc').setAttribute('d', on ? 'M7 5h3v14H7zm7 0h3v14h-3z' : 'M8 5v14l11-7z');
  }

  /* ------------------------------------------------------------- events */
  audio.addEventListener('playing', function () { setOn(true); st.errs = 0; });
  audio.addEventListener('pause', function () { if (!audio.ended) setOn(false); });
  audio.addEventListener('ended', advance);
  audio.addEventListener('error', function () {
    st.errs++;
    if (st.errs > st.segs.length + 2) { st.errs = 0; setTimeout(function () { load(false).then(function () { playAt(0); }).catch(function () {}); }, 4000); return; }
    setTimeout(advance, 600);
  });
  audio.addEventListener('timeupdate', function () {
    var d = audio.duration || 0;
    $('prog').style.width = d ? Math.min(100, (audio.currentTime / d) * 100) + '%' : '0%';
  });

  function openCard() { $('card').classList.add('open'); $('launch').style.display = 'none'; start(); }
  function minimise() { $('card').classList.remove('open'); $('launch').style.display = ''; }
  function closeAll() { minimise(); audio.pause(); try { sessionStorage.setItem(HIDE_KEY, '1'); } catch (e) {} host.style.display = 'none'; }

  $('launch').addEventListener('click', openCard);
  $('play').addEventListener('click', toggle);
  $('next').addEventListener('click', function () { if (!st.started) start(); else advance(); });
  $('min').addEventListener('click', minimise);
  $('close').addEventListener('click', closeAll);
  $('vol').addEventListener('input', function () { audio.volume = parseFloat(this.value); });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', start);
      navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { if (st.started) advance(); });
    } catch (e) {}
  }

  /* --------------------------------------------------------------- boot */
  try { if (sessionStorage.getItem(HIDE_KEY)) { host.style.display = 'none'; } } catch (e) {}
  load(false).catch(function () { setTimeout(function () { load(false).catch(function () {}); }, 8000); });
})();
