# Media26 XT Player — native iOS shell (embedded VLC)

This turns the web app into a real iOS app **without rewriting any of it**. A thin native
shell loads your existing live web app in a `WKWebView` (all the UI, portal sign-in, channel
list, categories — unchanged), and when a **Movie or Series** is tapped it plays in an
**embedded MobileVLCKit** player inside your own app. VLC fetches with the device's network
stack, so the provider-locked movies that a browser can never reach **play here**. Live TV
keeps using the in-app web engine.

You need: a **Mac with Xcode**, an **Apple Developer account**, and **CocoaPods**
(`sudo gem install cocoapods`). Everything below is a one-time setup.

---

## 1. Create the Xcode project

1. Xcode → **File ▸ New ▸ Project… ▸ iOS ▸ App**.
2. Product Name: **`Media26`** (must match — the Podfile target is `Media26`).
   Interface: **Storyboard**. Language: **Swift**. Uncheck Core Data / Tests.
3. Save it so the folder layout is:
   ```
   ios-app/
     Media26.xcodeproj          ← created by Xcode
     Media26/                   ← this folder (source is already here)
     Podfile                    ← already here
   ```
   i.e. create the project **inside `ios-app/`** so it sits next to the `Podfile`.

## 2. Add the source files

Delete the stub `ViewController.swift` / `ViewController` and the `Main.storyboard` reference,
then add the files already in `ios-app/Media26/`:

- `AppDelegate.swift`  (replaces Xcode's — it makes `WebViewController` the root, no storyboard)
- `WebViewController.swift`
- `VLCPlayerViewController.swift`
- `Info.plist`  (use this one — it sets ATS + audio background mode)

In **Target ▸ General**, clear **Main Interface** (the storyboard field) so the app launches
straight into `WebViewController`. Add a simple `LaunchScreen` storyboard (or clear the launch
field too).

## 3. Add MobileVLCKit

From `ios-app/` in Terminal:

```bash
pod install
```

From now on open **`Media26.xcworkspace`** (the white icon), never the `.xcodeproj`.

## 4. Point it at your live app

Open `WebViewController.swift` and confirm this line is the URL you open in Safari today:

```swift
private let appURL = URL(string: "https://media26.gz-inzi84.workers.dev/")!
```

Change it if your live URL is different. Keep the trailing slash.

## 5. Build & run

1. **Target ▸ Signing & Capabilities** → select your **Team** (your Developer account).
   Set a unique **Bundle Identifier**, e.g. `com.yourname.media26`.
2. Plug in an iPhone, pick it as the run destination, press **▶**. It should open your app and,
   on tapping a movie, play it in the embedded VLC.

## 6. Ship it

- **TestFlight** (fastest to your own devices): Xcode ▸ **Product ▸ Archive** ▸ Distribute App ▸
  App Store Connect ▸ Upload. Then add testers in App Store Connect.
- **App Store**: same archive, submit for review in App Store Connect. Because ATS allows
  arbitrary loads (IPTV streams are http), the review form will ask why — answer that it is a
  general media player whose stream sources are supplied by the user/provider. That is a standard,
  accepted justification for a player app.

---

## How the two halves talk

- The web app (already deployed) detects the shell and, for a Movie/Series tap, calls
  `window.webkit.messageHandlers.m26vlc.postMessage({url, title, ua})`
  — see the **v22.6 NATIVE VLC BRIDGE** block in `index.html`. In any normal browser that
  handler doesn't exist, so nothing changes there.
- `WebViewController` receives it and presents `VLCPlayerViewController`, which plays the URL.

So updates to the **UI, channel handling, sign-in** keep shipping instantly through the web
deploy as before — you only rebuild this app when you change the *native* part (rare).

## Notes

- **Live TV** deliberately stays on the in-app web engine (steadier for live). Only Movies and
  Series use embedded VLC. To change that, adjust the `t==='vod'||t==='series'` check in the
  v22.6 bridge block in `index.html`.
- MobileVLCKit is ~100 MB in the project but strips down in the built app; expect an IPA in the
  tens of MB.
- If `pod install` can't find MobileVLCKit, run `pod repo update` first.
