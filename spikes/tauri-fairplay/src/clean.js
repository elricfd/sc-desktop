// Hide SoundCloud's promotions, "events near you", artist upsells and footer
// clutter, and reject optional cookies. Ported from the Electron app's
// applyThemeToContent (src/main.ts). Runs in every frame at document start,
// and from custom.html's prepFrame for embedded pages: WebView2 skips init
// scripts when an iframe keeps its initial about:blank window. Once per document.
(() => {
  if (document.__scClean) return;
  document.__scClean = true;
  const css = `
    .banner.m-promotion, .sidebarModule.mobileApps, .velvetCakeModule { display: none !important; }
    .l-footer { font-size: 0 !important; line-height: 0 !important; }
    .l-footer > a { display: none !important; }
    .l-footer .footer__localeSelector { font-size: 14px !important; line-height: 20px !important; margin-top: 0 !important; }
    .header__upsellWrapper, .creatorSubscriptionsButton.header__creatorUpsell, .artistConnectItem.m-upsellNextPro,
    .dropdownMenu [href*="checkout.soundcloud.com"], .dropdownMenu *:has(> svg.profileMenu__icon path[fill="#F50"]),
    .spotlight:has(.spotlight__upsellBanner), .spotlight__upsellBanner, .spotlight__upsellCTA,
    .sidebarContent:has(.velvetCakeIframe), .quotaMeter__upsellText,
    .artistConnectContainer .tileGallery__sliderPeekForward, .artistConnectContainer .tileGallery__sliderPeekBackward,
    .MuiBox-root:has(a[href*="getstarted/fan-support"]),
    .quotaMeterWrapper, .banner:has(.firstFansPromotionBanner__link), .sidebarModule:has(iframe[src*="/n/embeds/credit-tracker"]) { display: none !important; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  // WebView2 runs this before <html> exists; WebKit after.
  const add = () => document.documentElement.appendChild(style);
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });

  // A sidebar module (same-origin iframe) that is nothing but a paywall goes
  // entirely: hide its container in the parent page.
  let container = null;
  try { container = window.frameElement?.closest('.webiEmbeddedModuleContainer'); } catch {}
  if (container) {
    const check = () => { container.style.display = document.querySelector('svg[aria-label="Paywalled feature"]') ? 'none' : ''; };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  }

  // Artist Pro upsell cards on SoundCloud's newer pages (/n/ frames, e.g. the
  // track page) have no stable class names: find their buttons by text and
  // hide the card around each, stopping below the column with Details/comments.
  if (location.pathname.startsWith('/n/')) {
    const UPSELL = /^(Upgrade|Get Artist Pro)$/;
    const hideCards = () => {
      for (const b of document.querySelectorAll('button')) {
        if (!UPSELL.test(b.textContent.trim()) || b.closest('[data-sc-upsell]')) continue;
        let card = b;
        for (let up = 0; up < 6 && card.parentElement && card.parentElement !== document.body && !/details|comments?/i.test(card.parentElement.innerText); up++) card = card.parentElement;
        // Only a card: never a whole section of a page without that column.
        if (/Artist Pro/.test(card.innerText) && card.innerText.length < 600) { card.dataset.scUpsell = ''; card.style.display = 'none'; }
      }
    };
    let timer = 0;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(hideCards, 150); }).observe(document, { childList: true, subtree: true });
  }

  // Opt out of every optional OneTrust cookie category (on by default).
  // OneTrust loads late and remembers the choice, so later loads find nothing.
  if (window.top === window) {
    let tries = 0;
    const timer = setInterval(() => {
      const ready = window.OneTrust && typeof window.OnetrustActiveGroups === 'string';
      if (!ready && ++tries < 60) return;
      clearInterval(timer);
      if (ready && /C000[2-4]/.test(window.OnetrustActiveGroups)) window.OneTrust.RejectAll();
    }, 500);
  }
})();
