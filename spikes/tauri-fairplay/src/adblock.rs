// Network ad/tracker blocking. macOS: a WebKit content rule list (Safari's
// content-blocker format, compiled natively by WebKit). Windows: WebView2's
// WebResourceRequested, answered with a 403 for the same hosts.
// Note: hand list of hosts SoundCloud loads plus common ad networks, not
// full EasyList (Electron uses Ghostery's lists); convert EasyList if ads
// slip through.
use wry::WebView;

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

#[cfg(any(target_os = "macos", test))]
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

/// The same rules as `rules()`, as a check on one URL (Windows has no rule
/// list to hand them to).
#[cfg(any(target_os = "windows", test))]
pub fn blocked(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else { return false };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase();
    HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
        || host == "artist-events.soundcloud.com"
        || (host == "soundcloud.com" && path.starts_with("n/embeds/credit-tracker"))
        || (host == "www.facebook.com" && path.starts_with("tr"))
}

/// Compile the rules and attach them, then call `done` (on the main thread)
/// whether or not that worked, so the page loads either way.
#[cfg(target_os = "macos")]
pub fn install(webview: &WebView, done: impl Fn() + 'static) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore};
    use wry::WebViewExtMacOS;
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

/// Refuse blocked requests, then call `done` whether or not that worked, so
/// the page loads either way.
#[cfg(target_os = "windows")]
pub fn install(webview: &WebView, done: impl Fn() + 'static) {
    use webview2_com::{WebResourceRequestedEventHandler, take_pwstr};
    use windows::core::{HSTRING, PWSTR};
    use wry::WebViewExtWindows;
    let (wv, env) = (webview.webview(), webview.environment());
    // One filter per rule, so other requests never leave the browser process.
    let filters = HOSTS.iter().flat_map(|h| [format!("*://{h}/*"), format!("*://*.{h}/*")]).chain([
        "*://artist-events.soundcloud.com/*".to_string(),
        "*://soundcloud.com/n/embeds/credit-tracker*".to_string(),
        "*://www.facebook.com/tr*".to_string(),
    ]);
    let result = (|| -> windows::core::Result<()> {
        for f in filters {
            crate::add_filter(&wv, &f)?;
        }
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            unsafe {
                let mut uri = PWSTR::null();
                args.Request()?.Uri(&mut uri)?;
                // filters are shared with other handlers (main.rs serves our page through one)
                if blocked(&take_pwstr(uri)) {
                    args.SetResponse(&env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked"), &HSTRING::new())?)?;
                }
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe { wv.add_WebResourceRequested(&handler, &mut token) }
    })();
    if let Err(e) = result {
        eprintln!("adblock: {e}");
    }
    done();
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

    #[test]
    fn blocked_matches_hosts_subdomains_and_path_rules() {
        use super::blocked;
        for url in [
            "https://doubleclick.net/x",
            "https://stats.g.doubleclick.net/collect?a=1",
            "http://WWW.GoogleTagManager.com:443/gtm.js",
            "https://artist-events.soundcloud.com/",
            "https://soundcloud.com/n/embeds/credit-tracker?x",
            "https://www.facebook.com/tr?id=1",
        ] {
            assert!(blocked(url), "{url}");
        }
        for url in [
            "https://soundcloud.com/__app",
            "https://soundcloud.com/discover",
            "https://api-v2.soundcloud.com/me",
            "https://notdoubleclick.net/",
            "https://www.facebook.com/soundcloud",
            "https://www.google.com/recaptcha/api.js",
            "https://example.com/?u=https://doubleclick.net/",
            "about:blank",
        ] {
            assert!(!blocked(url), "{url}");
        }
    }
}
