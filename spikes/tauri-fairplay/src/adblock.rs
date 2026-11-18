// Network ad/tracker blocking with a WebKit content rule list (Safari's
// content-blocker format, compiled natively by WebKit).
// Note: hand list of hosts SoundCloud loads plus common ad networks, not
// full EasyList (Electron uses Ghostery's lists); convert EasyList if ads
// slip through.
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore};
use wry::{WebView, WebViewExtMacOS};

// Hosts blocked with their subdomains. Not here on purpose: www.google.com
// (reCAPTCHA for sign-in), OneTrust/cookielaw (clean.js rejects its cookies).
const HOSTS: &[&str] = &[
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "connect.facebook.net",
    "redditstatic.com",
    "alb.reddit.com",
    "moengage.com",
    "adswizz.com",
    "scorecardresearch.com",
    "quantserve.com",
    "amazon-adsystem.com",
    "adnxs.com",
    "criteo.com",
    "pubmatic.com",
    "rubiconproject.com",
    "moatads.com",
    "bat.bing.com",
];

pub fn rules() -> String {
    let mut rules: Vec<String> = HOSTS
        .iter()
        .map(|h| {
            let h = h.replace('.', "\\\\.");
            format!(r#"{{"trigger":{{"url-filter":"^[^:]+://+([^:/]+\\.)?{h}[:/]"}},"action":{{"type":"block"}}}}"#)
        })
        .collect();
    // Hidden SoundCloud iframes that still load (and cost ~50 MB in the page
    // process): "Concerts near you" (clean.js hides it) and the artist-tools
    // sidebar module, not shown on the pages that load it.
    rules.push(r#"{"trigger":{"url-filter":"^https?://artist-events\\.soundcloud\\.com/"},"action":{"type":"block"}}"#.into());
    rules.push(r#"{"trigger":{"url-filter":"^https?://soundcloud\\.com/n/embeds/credit-tracker"},"action":{"type":"block"}}"#.into());
    // Facebook's tracking pixel, without blocking facebook.com itself.
    rules.push(r#"{"trigger":{"url-filter":"^https?://www\\.facebook\\.com/tr"},"action":{"type":"block"}}"#.into());
    format!("[{}]", rules.join(","))
}

/// Compile the rules and attach them, then call `done` (on the main thread)
/// whether or not that worked, so the page loads either way.
pub fn install(webview: &WebView, done: impl Fn() + 'static) {
    let controller = unsafe { webview.webview().configuration().userContentController() };
    let mtm = MainThreadMarker::new().expect("main thread");
    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        eprintln!("adblock: no content rule list store");
        return done();
    };
    let handler = RcBlock::new(move |list: *mut WKContentRuleList, err: *mut NSError| {
        match unsafe { list.as_ref() } {
            Some(list) => unsafe { controller.addContentRuleList(list) },
            None => eprintln!("adblock: compile failed: {:?}", unsafe { err.as_ref() }),
        }
        done();
    });
    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str("sc-adblock")),
            Some(&NSString::from_str(&rules())),
            Some(&handler),
        )
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn rules_are_json_with_one_rule_per_host() {
        let r = super::rules();
        assert!(r.starts_with("[{") && r.ends_with("}]"));
        assert_eq!(r.matches(r#""type":"block""#).count(), super::HOSTS.len() + 3);
        assert!(r.contains(r#"([^:/]+\\.)?googletagmanager\\.com[:/]"#));
    }
}
