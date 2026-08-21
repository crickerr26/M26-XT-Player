import UIKit
import MobileVLCKit

// The embedded native player. MobileVLCKit == libVLC == the same engine as the VLC app, so it
// fetches with the device's own network stack (bypasses the browser sandbox and the provider's
// server-side block) and decodes anything — MKV, HEVC, AC3, DTS, MPEG-2, unstable TS.
// Full-screen, tap to toggle controls, with play/pause, a scrubber, and Done.

final class VLCPlayerViewController: UIViewController {

    private let url: URL
    private let titleText: String
    private let userAgent: String

    private let player = VLCMediaPlayer()
    private let videoView = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let controls = UIView()
    private let playPause = UIButton(type: .system)
    private let doneBtn = UIButton(type: .system)
    private let titleLbl = UILabel()
    private let scrubber = UISlider()
    private let timeLbl = UILabel()
    private let errorLbl = UILabel()
    private var controlsHidden = false
    private var seeking = false

    init(url: URL, title: String, userAgent: String) {
        self.url = url; self.titleText = title; self.userAgent = userAgent
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()

        // Feed VLC the media. The user-agent option matters: many IPTV panels only answer a
        // player UA, and it is exactly the UA the web app already uses (passed in from JS).
        let media = VLCMedia(url: url)
        if !userAgent.isEmpty {
            media.addOption(":http-user-agent=\(userAgent)")
        }
        media.addOption(":network-caching=1500")   // a little buffer for a smooth start
        player.media = media
        player.drawable = videoView
        player.delegate = self
        player.play()
        spinner.startAnimating()

        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        player.stop()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersStatusBarHidden: Bool { controlsHidden }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }

    // ── UI ───────────────────────────────────────────────────────────────────────────────────────
    private func buildUI() {
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        videoView.backgroundColor = .black
        view.addSubview(videoView)

        spinner.color = .white
        spinner.center = view.center
        spinner.autoresizingMask = [.flexibleTopMargin, .flexibleBottomMargin, .flexibleLeftMargin, .flexibleRightMargin]
        view.addSubview(spinner)

        errorLbl.textColor = .white
        errorLbl.font = .systemFont(ofSize: 15, weight: .medium)
        errorLbl.numberOfLines = 0
        errorLbl.textAlignment = .center
        errorLbl.isHidden = true
        errorLbl.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorLbl)
        NSLayoutConstraint.activate([
            errorLbl.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            errorLbl.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorLbl.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            errorLbl.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)
        ])

        controls.frame = view.bounds
        controls.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(controls)

        // top bar: Done + title
        doneBtn.setTitle("Done", for: .normal)
        doneBtn.setTitleColor(.white, for: .normal)
        doneBtn.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        doneBtn.addTarget(self, action: #selector(done), for: .touchUpInside)
        doneBtn.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(doneBtn)

        titleLbl.text = titleText
        titleLbl.textColor = .white
        titleLbl.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLbl.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(titleLbl)

        // center play/pause
        playPause.tintColor = .white
        playPause.setImage(UIImage(systemName: "pause.circle.fill",
                                   withConfiguration: UIImage.SymbolConfiguration(pointSize: 64)), for: .normal)
        playPause.addTarget(self, action: #selector(togglePlay), for: .touchUpInside)
        playPause.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(playPause)

        // bottom: scrubber + time
        scrubber.minimumTrackTintColor = .white
        scrubber.addTarget(self, action: #selector(scrubStart), for: .touchDown)
        scrubber.addTarget(self, action: #selector(scrubEnd), for: [.touchUpInside, .touchUpOutside])
        scrubber.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(scrubber)

        timeLbl.textColor = .white
        timeLbl.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        timeLbl.text = "0:00"
        timeLbl.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(timeLbl)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            doneBtn.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            doneBtn.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            titleLbl.leadingAnchor.constraint(equalTo: doneBtn.trailingAnchor, constant: 14),
            titleLbl.centerYAnchor.constraint(equalTo: doneBtn.centerYAnchor),
            titleLbl.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -16),
            playPause.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            playPause.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            scrubber.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            scrubber.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -12),
            timeLbl.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            timeLbl.centerYAnchor.constraint(equalTo: scrubber.centerYAnchor),
            scrubber.trailingAnchor.constraint(equalTo: timeLbl.leadingAnchor, constant: -10)
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        view.addGestureRecognizer(tap)
        scheduleHide()
    }

    // ── controls ──────────────────────────────────────────────────────────────────────────────────
    @objc private func done() { dismiss(animated: true) }

    @objc private func togglePlay() {
        if player.isPlaying { player.pause() } else { player.play() }
        refreshPlayIcon()
        scheduleHide()
    }
    private func refreshPlayIcon() {
        let name = player.isPlaying ? "pause.circle.fill" : "play.circle.fill"
        playPause.setImage(UIImage(systemName: name,
                                   withConfiguration: UIImage.SymbolConfiguration(pointSize: 64)), for: .normal)
    }

    @objc private func scrubStart() { seeking = true }
    @objc private func scrubEnd() {
        player.position = scrubber.value
        seeking = false
        scheduleHide()
    }

    @objc private func toggleControls() {
        controlsHidden.toggle()
        UIView.animate(withDuration: 0.2) { self.controls.alpha = self.controlsHidden ? 0 : 1 }
        setNeedsStatusBarAppearanceUpdate()
        if !controlsHidden { scheduleHide() }
    }
    private func scheduleHide() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(hideControls), object: nil)
        perform(#selector(hideControls), with: nil, afterDelay: 4)
    }
    @objc private func hideControls() {
        guard player.isPlaying, !controlsHidden else { return }
        controlsHidden = true
        UIView.animate(withDuration: 0.2) { self.controls.alpha = 0 }
        setNeedsStatusBarAppearanceUpdate()
    }

    private func fmt(_ ms: Int) -> String {
        let s = max(0, ms / 1000); let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
}

extension VLCPlayerViewController: VLCMediaPlayerDelegate {
    func mediaPlayerStateChanged(_ aNotification: Notification) {
        switch player.state {
        case .playing, .opening, .buffering:
            spinner.stopAnimating(); errorLbl.isHidden = true; refreshPlayIcon()
        case .error:
            spinner.stopAnimating()
            errorLbl.text = "This title could not be played.\nTap Done and try another."
            errorLbl.isHidden = false
        case .ended, .stopped:
            spinner.stopAnimating()
        default:
            break
        }
    }
    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        if !seeking { scrubber.value = player.position }
        let cur = Int(player.time.intValue)
        let total = player.media?.length.intValue ?? 0
        timeLbl.text = total > 0 ? "\(fmt(cur)) / \(fmt(Int(total)))" : fmt(cur)
    }
}
