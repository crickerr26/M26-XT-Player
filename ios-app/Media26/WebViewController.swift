import UIKit
import WebKit

// Hosts the deployed Media26 web app full-screen, and listens for the JS bridge the web app
// calls when a Movie/Series is tapped:  window.webkit.messageHandlers.m26vlc.postMessage({url,title,ua})
// (see the v22.6 "NATIVE VLC BRIDGE" block in index.html). On each message it presents the
// embedded VLC player over the web UI.

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    // ── SET THIS to the URL you open in Safari today (the live web app). ─────────────────────────
    // It is the ONLY thing you must confirm before building. Keep the trailing slash.
    private let appURL = URL(string: "https://media26.gz-inzi84.workers.dev/")!

    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // Register the bridge the web app posts to.
        cfg.userContentController.add(self, name: "m26vlc")
        // Tell the web app it is inside the native shell (in case you want to branch on it in JS).
        cfg.userContentController.addUserScript(WKUserScript(
            source: "window.__M26_NATIVE__ = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: false))

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        // A distinct UA so you can tell native-shell traffic apart if you ever need to.
        webView.customUserAgent = (webView.value(forKey: "userAgent") as? String ?? "") + " Media26Native/1.0"
        view.addSubview(webView)

        webView.load(URLRequest(url: appURL))
    }

    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // ── JS → native: play this stream in VLC ─────────────────────────────────────────────────────
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "m26vlc",
              let body = message.body as? [String: Any],
              let urlStr = body["url"] as? String,
              let url = URL(string: urlStr) else { return }
        let title = body["title"] as? String ?? ""
        let ua = body["ua"] as? String ?? ""

        let player = VLCPlayerViewController(url: url, title: title, userAgent: ua)
        player.modalPresentationStyle = .fullScreen
        present(player, animated: true)
    }
}
