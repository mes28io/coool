import AVFoundation
import RemoteProtocol
import SwiftUI

struct PairingView: View {
  @Environment(RemoteStore.self) private var store
  @AppStorage("deviceName") private var name = "iPhone"
  @State private var link = ""
  @State private var scanning = false
  @FocusState private var focused: Bool

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        VStack(alignment: .leading, spacing: 8) {
          Wordmark()
          Text("Watch and steer coool on your Mac from this iPhone.")
            .font(.title3).foregroundStyle(Theme.dim)
        }
        .padding(.top, 28)

        if let notice = store.revokedNotice {
          Card(stroke: Theme.needs) {
            Label("Removed on your Mac", systemImage: "iphone.slash")
              .font(.headline).foregroundStyle(Theme.text)
            Text(notice).font(.subheadline).foregroundStyle(Theme.dim)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("pair.revoked")
        }

        Card {
          step(1, "On your Mac, open coool, then Settings > Remote.")
          step(2, "Turn Remote on and choose Pair an iPhone.")
          step(3, "Scan the code it shows, then check that both screens show the same six digits.")
        }

        Button {
          scanning = true
        } label: {
          Label("Scan the code", systemImage: "qrcode.viewfinder")
        }
        .buttonStyle(PrimaryButtonStyle())
        .accessibilityIdentifier("pair.scan")

        VStack(alignment: .leading, spacing: 10) {
          Text("Or paste the pairing link").font(.subheadline.weight(.medium)).foregroundStyle(Theme.dim)
          HStack(spacing: 8) {
            TextField("coool://pair?…", text: $link, axis: .vertical)
              .lineLimit(1...3)
              .font(.callout.monospaced())
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($focused)
              .padding(12)
              .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
              .accessibilityLabel("Pairing link")
              .accessibilityIdentifier("pair.link")
            PasteButton(payloadType: String.self) { s in
              if let first = s.first { link = first }
            }
            .labelStyle(.iconOnly)
            .buttonBorderShape(.roundedRectangle(radius: 12))
            .tint(Theme.raised)
          }
          Button("Pair") {
            focused = false
            store.pair(text: link, name: name)
          }
          .buttonStyle(SecondaryButtonStyle())
          .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("pair.submit")
          if let e = store.pairError {
            Label(e, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.error)
              .accessibilityIdentifier("pair.error")
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          Text("This iPhone's name on your Mac").font(.subheadline.weight(.medium)).foregroundStyle(Theme.dim)
          TextField("iPhone", text: $name)
            .padding(12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
            .accessibilityLabel("This iPhone's name on your Mac")
            .accessibilityIdentifier("pair.name")
        }

        Label("End to end encrypted. The relay passes sealed messages between this iPhone and your Mac and can't read them. No account, no tracking.", systemImage: "lock")
          .font(.footnote).foregroundStyle(Theme.faint)
          .padding(.bottom, 24)
      }
      .padding(.horizontal, 20)
    }
    .scrollDismissesKeyboard(.interactively)
    .sheet(isPresented: $scanning) {
      ScannerSheet { text in
        scanning = false
        store.pair(text: text, name: name)
      }
    }
  }

  private func step(_ n: Int, _ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text("\(n)").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.dim)
        .frame(width: 24, height: 24).background(Theme.raised, in: Circle())
      Text(text).font(.body).foregroundStyle(Theme.text)
    }
    .accessibilityElement(children: .combine)
  }
}

struct ClaimView: View {
  @Environment(RemoteStore.self) private var store

  var body: some View {
    VStack(spacing: 24) {
      Spacer()
      switch store.claimState {
      case .waiting(let code):
        VStack(spacing: 14) {
          Text("Check the code").font(.title2.weight(.semibold)).foregroundStyle(Theme.text)
          Text("\(code.prefix(3)) \(code.suffix(3))")
            .font(.system(size: 52, weight: .bold, design: .rounded).monospacedDigit())
            .foregroundStyle(Theme.text)
            .accessibilityLabel(code.map(String.init).joined(separator: " "))
            .accessibilityValue(code)
            .accessibilityIdentifier("pair.code")
          Text("Your Mac shows a code too. If it's the same, click Pair on the Mac. If it isn't, click Cancel there.")
            .font(.body).foregroundStyle(Theme.dim).multilineTextAlignment(.center)
          HStack(spacing: 8) {
            ProgressView()
            Text("Waiting for your Mac").foregroundStyle(Theme.faint)
          }
          .padding(.top, 8)
        }
      case .sending, nil:
        ProgressView("Contacting the relay").foregroundStyle(Theme.dim)
      case .refused:
        outcome("Pairing was cancelled on your Mac.", "xmark.circle")
      case .expired:
        outcome("The code expired before it was confirmed. Make a new one on your Mac and scan it again.", "clock")
      case .failed(let msg):
        outcome(msg, "exclamationmark.circle")
      }
      Spacer()
      Button(isWaiting ? "Cancel" : "Back") { store.cancelClaim() }
        .buttonStyle(SecondaryButtonStyle())
        .accessibilityIdentifier("pair.cancel")
    }
    .padding(24)
  }

  private var isWaiting: Bool {
    if case .waiting = store.claimState { return true }
    return store.claimState == .sending
  }

  private func outcome(_ text: String, _ icon: String) -> some View {
    VStack(spacing: 14) {
      Image(systemName: icon).font(.system(size: 40)).foregroundStyle(Theme.faint).accessibilityHidden(true)
      Text(text).font(.body).foregroundStyle(Theme.text).multilineTextAlignment(.center)
        .accessibilityIdentifier("pair.outcome")
    }
  }
}

// ---------------------------------------------------------------- the camera

struct ScannerSheet: View {
  let found: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var problem: String?

  var body: some View {
    NavigationStack {
      ZStack {
        Color.black.ignoresSafeArea()
        if let problem {
          VStack(spacing: 12) {
            Image(systemName: "camera").font(.largeTitle).accessibilityHidden(true)
            Text(problem).multilineTextAlignment(.center)
          }
          .foregroundStyle(.white).padding(32)
        } else {
          QRScanner(found: found, failed: { problem = $0 }).ignoresSafeArea()
          RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(.white.opacity(0.8), lineWidth: 2)
            .frame(width: 240, height: 240).accessibilityHidden(true)
        }
      }
      .navigationTitle("Scan the code").navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(.visible, for: .navigationBar)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
  }
}

/// A QR reader on AVFoundation: it takes only a `coool://pair?` code, once.
struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void
  let failed: (String) -> Void

  func makeUIViewController(context: Context) -> ScannerController {
    let c = ScannerController()
    c.found = found
    c.failed = failed
    return c
  }
  func updateUIViewController(_ c: ScannerController, context: Context) {}

  final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var found: ((String) -> Void)?
    var failed: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var done = false

    override func viewDidLoad() {
      super.viewDidLoad()
      view.backgroundColor = .black
      AVCaptureDevice.requestAccess(for: .video) { ok in
        DispatchQueue.main.async { ok ? self.start() : self.failed?("coool Remote needs the camera to scan the code. Allow it in Settings, or paste the link instead.") }
      }
    }

    private func start() {
      guard let cam = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: cam), session.canAddInput(input) else {
        failed?("The camera isn't available here. Paste the pairing link instead.")
        return
      }
      session.addInput(input)
      let out = AVCaptureMetadataOutput()
      guard session.canAddOutput(out) else { return }
      session.addOutput(out)
      out.setMetadataObjectsDelegate(self, queue: .main)
      out.metadataObjectTypes = [.qr]
      let p = AVCaptureVideoPreviewLayer(session: session)
      p.videoGravity = .resizeAspectFill
      p.frame = view.bounds
      view.layer.addSublayer(p)
      preview = p
      DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
      super.viewDidLayoutSubviews()
      preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
      super.viewWillDisappear(animated)
      if session.isRunning { DispatchQueue.global().async { self.session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
      guard !done else { return }
      for o in objects {
        if let s = (o as? AVMetadataMachineReadableCodeObject)?.stringValue, s.hasPrefix("coool://pair?") {
          done = true
          UINotificationFeedbackGenerator().notificationOccurred(.success)
          found?(s)
          return
        }
      }
    }
  }
}
