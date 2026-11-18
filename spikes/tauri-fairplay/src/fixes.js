// Page fixes for SoundCloud's Go+ (FairPlay) player in WKWebView. Runs before
// any page script.
(() => {
  // 1. Seeks past the buffer never load. hls.js prefers WebKit's
  // ManagedMediaSource, pauses loading on "endstreaming" and waits for WebKit
  // to fire "startstreaming", which WKWebView never does after such a seek.
  // Hidden, hls.js uses plain MediaSource: FairPlay works there and loading
  // never pauses.
  delete window.ManagedMediaSource;

  // 2. A skip goes silent (clock and UI keep running) until a second skip.
  // SoundCloud re-sets currentTime to the same value every ~40 ms until
  // "seeked"; on encrypted audio WebKit's renderer doesn't survive seeking
  // again mid-seek. Drop those repeats so each skip seeks once.
  // Note: works around a WebKit FairPlay bug; recheck after WebKit updates.
  const M = HTMLMediaElement.prototype;
  const ct = Object.getOwnPropertyDescriptor(M, 'currentTime');
  const pending = new WeakMap();
  Object.defineProperty(M, 'currentTime', { ...ct, set(v) {
    if (this.mediaKeys && this.seeking && Math.abs(v - pending.get(this)) < 0.05) return;
    pending.set(this, +v);
    ct.set.call(this, v);
  } });
})();
