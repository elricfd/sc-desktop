// Report the player bar's track to Rust ("np:" + JSON) when the track or
// play state changes, or the position jumps (a seek). Main frame only.
// Selectors as in the Electron app's audioMonitorService.
(() => {
  if (window.top !== window) return;
  const ms = text => {
    if (!text) return 0;
    const t = text.trim(), neg = t.startsWith('-');
    const s = (neg ? t.slice(1) : t).split(':').reduce((acc, p) => acc * 60 + (Number(p) || 0), 0);
    return (neg ? -s : s) * 1000;
  };
  const q = s => document.querySelector(s);
  let last = null, lastAt = 0;
  setInterval(() => {
    const art = q('.playbackSoundBadge__avatar .image__lightOutline span');
    const link = q('.playbackSoundBadge__titleLink');
    if (!link) return;
    const elapsed = Math.max(0, ms(q('.playbackTimeline__timePassed span:last-child')?.textContent));
    const total = ms(q('.playbackTimeline__duration span:last-child')?.textContent);
    const np = {
      title: art?.getAttribute('aria-label') || link.getAttribute('title') || '',
      author: q('.playbackSoundBadge__lightLink')?.textContent.trim() || '',
      url: link.href.split('?')[0],
      artwork: (art?.style.backgroundImage || '').replace(/^url\(["']?|["']?\)$/g, '').replace('50x50.', '500x500.'),
      playing: !!q('.playControls__play')?.classList.contains('playing'),
      elapsed,
      // a negative duration is "time remaining"
      duration: total < 0 ? elapsed - total : total,
    };
    const now = Date.now();
    const drift = last && last.playing ? Math.abs(np.elapsed - (last.elapsed + (now - lastAt))) : 0;
    if (!last || np.url !== last.url || np.title !== last.title || np.playing !== last.playing || drift > 3000) {
      window.ipc.postMessage('np:' + JSON.stringify(np));
    }
    last = np; lastAt = now;
  }, 1000);
})();
