// Debug trace (TRACE=1): DRM support, media/EME/MSE events, hls.js internals,
// pause callers, and helpers to drive seeks from stdin. Main frame only.
(() => {
  if (window.top !== window) return;
  const t0 = performance.now();
  const say = m => window.ipc.postMessage(`${((performance.now() - t0) / 1000).toFixed(2)}s ${m}`);
  const NL = String.fromCharCode(10);
  const stack = () => (new Error().stack || '').split(NL).slice(2, 8)
    .map(l => l.replace(/https:\/\/[^ )]*\/assets\//, '').trim()).join(' <- ');

  say(`UA ${navigator.userAgent}`);
  say(`ManagedMediaSource visible: ${'ManagedMediaSource' in window}`);
  const cfg = [{ initDataTypes: ['sinf', 'skd'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }];
  (async () => {
    for (const ks of ['com.apple.fps', 'com.widevine.alpha']) {
      try { await navigator.requestMediaKeySystemAccess(ks, cfg); say(`EME ${ks}: yes`); }
      catch (e) { say(`EME ${ks}: no (${e.name})`); }
    }
  })();

  // Media element (SoundCloud's is detached from the DOM: hook prototypes).
  const kind = s => !s ? '(none)' : s.startsWith('blob:') ? 'blob(MSE)' : 'url';
  const st = a => `t=${a.currentTime.toFixed(1)} rs=${a.readyState} paused=${a.paused}`;
  const seen = new WeakSet();
  window.__audio = null;
  const watch = a => {
    if (seen.has(a)) return;
    seen.add(a);
    window.__audio = a;
    say(`media element src=${kind(a.currentSrc || a.src)}`);
    for (const ev of ['loadstart', 'playing', 'waiting', 'stalled', 'seeked', 'emptied', 'ended', 'pause'])
      a.addEventListener(ev, () => say(`audio ${ev} ${st(a)}`));
    a.addEventListener('encrypted', e => say(`audio encrypted ${e.initDataType}`));
    a.addEventListener('error', () => say(`audio ERROR ${a.error?.code} ${a.error?.message}`));
  };
  const M = HTMLMediaElement.prototype;
  const play = M.play;
  M.play = function () { watch(this); return play.apply(this, arguments); };
  const pause = M.pause;
  M.pause = function () { say(`CALL pause() ${st(this)} :: ${stack()}`); return pause.apply(this, arguments); };
  const ct = Object.getOwnPropertyDescriptor(M, 'currentTime');
  Object.defineProperty(M, 'currentTime', { ...ct, set(v) {
    watch(this); say(`set currentTime=${(+v).toFixed(1)} from ${st(this)}`); ct.set.call(this, v);
  } });

  // EME
  const gr = MediaKeySession.prototype.generateRequest;
  MediaKeySession.prototype.generateRequest = function (type) {
    say(`EME generateRequest ${type}`);
    this.addEventListener('keystatuseschange', () => { const s = []; this.keyStatuses.forEach(v => s.push(v)); say(`EME keys ${[...new Set(s)]}`); });
    return gr.apply(this, arguments);
  };

  // hls.js: catch its stream controller via the bound "seeking" listener,
  // then route its logs and load calls here.
  const boundThis = new WeakMap();
  const bind = Function.prototype.bind;
  Function.prototype.bind = function (thisArg) {
    const b = bind.apply(this, arguments);
    if (thisArg && typeof thisArg === 'object') boundThis.set(b, thisArg);
    return b;
  };
  const hooked = new WeakSet();
  const ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn) {
    if (type === 'seeking' && this instanceof HTMLMediaElement) {
      const sc = boundThis.get(fn);
      if (sc && 'fragmentTracker' in sc) setTimeout(() => {
        const hls = sc.hls;
        if (!hls || hooked.has(hls)) return;
        hooked.add(hls);
        window.__sc = sc;
        say('hls.js found');
        for (const c of [sc, ...(hls.coreComponents || []), ...(hls.networkControllers || [])])
          for (const lvl of ['warn', 'error'])
            if (typeof c[lvl] === 'function') c[lvl] = (...a) => say(`hls ${lvl}: ${a.join(' ').slice(0, 200)}`);
        for (const fn of ['stopLoad', 'startLoad', 'pauseBuffering', 'resumeBuffering']) {
          const o = hls[fn];
          hls[fn] = function () { say(`CALL hls.${fn}(${[...arguments]}) :: ${stack()}`); return o.apply(this, arguments); };
        }
      });
    }
    return ael.apply(this, arguments);
  };

  // Helpers for stdin-driven tests.
  window.__buf = () => { const b = __audio.buffered, r = []; for (let i = 0; i < b.length; i++) r.push(`${b.start(i).toFixed(0)}-${b.end(i).toFixed(0)}`); return r.join(','); };
  window.__status = () => {
    const a = __audio, p = document.querySelector('.playControl');
    const title = document.querySelector('.playbackSoundBadge__titleLink');
    say(`TEST status audio=${!!a} ${a ? st(a) : ''} dur=${a?.duration?.toFixed(1)} encrypted=${!!a?.mediaKeys} uiPlaying=${p?.classList.contains('playing')} signedIn=${!!document.querySelector('.header__userNavUsernameButton, .header__userNavButton')} title=${title?.getAttribute('href')}`);
  };
  window.__seekUI = frac => {
    const w = document.querySelector('.playbackTimeline__progressWrapper');
    const r = w.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width * frac, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const ev of ['mousedown', 'mouseup', 'click']) w.dispatchEvent(new MouseEvent(ev, o));
  };
  window.__replay = async (fracs, gapMs) => {
    const a = __audio;
    for (const [i, f] of fracs.entries()) {
      const before = a.currentTime, target = a.duration * f;
      __seekUI(f);
      await new Promise(r => setTimeout(r, gapMs));
      const ok = !a.paused && Math.abs(a.currentTime - target) < gapMs / 1000 + 1.5;
      say(`TEST seek #${i + 1} ${before.toFixed(1)} -> ${target.toFixed(1)}: t=${a.currentTime.toFixed(1)} ${ok ? 'PASS' : 'FAIL'} paused=${a.paused} buf=${__buf()}`);
    }
    say('TEST replay done');
  };
})();
