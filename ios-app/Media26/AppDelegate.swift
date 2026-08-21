import UIKit

// Media26 XT Player — native iOS shell.
// The whole app UI is your existing web app, loaded in a WKWebView (see WebViewController).
// The only native part is playback: a Movie/Series tap is handed to an embedded MobileVLCKit
// player, which fetches the stream with the device's own network stack (no browser sandbox,
// no CORS, no mixed-content, no datacenter block) and decodes any codec. That is why the
// provider-locked movies play here and nowhere a browser can reach.

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = WebViewController()
        win.makeKeyAndVisible()
        self.window = win
        return true
    }
}
