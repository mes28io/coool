// Voice to prompt on the phone: record here, transcribe on the Mac.
//
// The recording is AAC (16 kHz mono, about 24 kbit/s: some 3 KB a second, so two minutes is about 360 KB, eight relay
// messages) in the app's temporary folder, deleted as soon as it is read. It goes to the Mac encrypted like
// everything else, where coool's own dictation turns it into text: the person's whisper model, translation to English
// if they set it, their word memory and corrections. The text comes back into the field to check before sending.
//
// Hold the microphone to talk and let go to finish; or tap it to start, then Done or Cancel. The bar shows the level
// live and the time. Under test (`--e2e-audio <file>`, debug builds) the file stands in for the microphone: it is
// handed over exactly where a recording would be.

import AVFoundation
import Observation
import RemoteProtocol
import SwiftUI

@MainActor
@Observable
final class VoiceCapture {
  enum Phase: Equatable { case idle, recording, transcribing }
  var phase: Phase = .idle
  /// The last levels, 0...1, newest last (the bar's waveform).
  var levels: [Float] = Array(repeating: 0, count: 28)
  var started = Date()
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var timer: Timer?
  @ObservationIgnored private var url: URL?
  @ObservationIgnored private var injected: Data?

  /// Starts recording; returns why it can't, if it can't.
  func start() async -> String? {
    guard phase == .idle else { return nil }
    #if DEBUG
      if let p = Demo.arg("--e2e-audio"), let d = FileManager.default.contents(atPath: p) {
        injected = d
        begin()
        return nil
      }
    #endif
    let granted = await AVAudioApplication.requestRecordPermission()
    guard granted else { return "Microphone access is off for coool Remote. Turn it on in Settings > Privacy & Security > Microphone." }
    do {
      let s = AVAudioSession.sharedInstance()
      try s.setCategory(.record, mode: .spokenAudio)
      try s.setActive(true)
      let u = FileManager.default.temporaryDirectory.appending(path: "voice-\(randomId()).m4a")
      let r = try AVAudioRecorder(url: u, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 24_000,
      ])
      r.isMeteringEnabled = true
      guard r.record(forDuration: Remote.maxAudioSeconds) else { return "The microphone couldn't start." }
      recorder = r
      url = u
      begin()
      return nil
    } catch {
      return "The microphone couldn't start: \(error.localizedDescription)"
    }
  }

  private func begin() {
    started = Date()
    levels = Array(repeating: 0, count: levels.count)
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    withAnimation(Theme.settle) { phase = .recording }
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.meter() }
    }
  }

  private func meter() {
    var v: Float
    if let r = recorder {
      r.updateMeters()
      v = max(0, min(1, pow(10, r.averagePower(forChannel: 0) / 20) * 2.2))
      if !r.isRecording, phase == .recording { Task { _ = finish() } }  // the two minutes are up
    } else {
      // An injected recording: a level that looks like speech.
      let t = Float(Date().timeIntervalSince(started))
      v = 0.35 + 0.3 * abs(sin(t * 7)) * abs(sin(t * 2.3))
    }
    levels.removeFirst()
    levels.append(v)
  }

  var seconds: Int { Int(Date().timeIntervalSince(started)) }

  /// Stops and returns the recording (and deletes the file).
  func finish() -> Data? {
    guard phase == .recording else { return nil }
    timer?.invalidate()
    timer = nil
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    if let d = injected {
      injected = nil
      return d
    }
    recorder?.stop()
    recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    guard let u = url else { phase = .idle; return nil }
    url = nil
    let d = try? Data(contentsOf: u)
    try? FileManager.default.removeItem(at: u)
    if Date().timeIntervalSince(started) < 0.4 {
      phase = .idle
      return nil
    }
    return d
  }

  func cancel() {
    timer?.invalidate()
    timer = nil
    injected = nil
    recorder?.stop()
    recorder?.deleteRecording()
    recorder = nil
    if let u = url { try? FileManager.default.removeItem(at: u) }
    url = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    withAnimation(Theme.settle) { phase = .idle }
  }

  #if DEBUG
    /// Screenshots: the bar mid-recording with an invented level, or transcribing.
    func pretend(_ p: Phase) {
      started = Date().addingTimeInterval(-7)
      levels = (0..<levels.count).map { i in 0.2 + 0.6 * abs(sin(Float(i) * 0.7)) * abs(sin(Float(i) * 0.23)) }
      phase = p
    }
  #endif
}

/// The microphone in the field: hold to talk (let go to finish), or tap to start.
struct MicButton: View {
  let voice: VoiceCapture
  let start: () -> Void
  let finish: () -> Void
  @State private var down: Date?

  var body: some View {
    Image(systemName: "mic.fill")
      .font(.body.weight(.medium))
      .foregroundStyle(Theme.dim)
      .frame(width: 38, height: 40)
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in
            guard down == nil else { return }
            down = Date()
            start()
          }
          .onEnded { _ in
            // Held: let go to finish. A tap leaves it recording, with Done and Cancel.
            if let d = down, Date().timeIntervalSince(d) > 0.45 { finish() }
            down = nil
          }
      )
      .accessibilityElement()
      .accessibilityLabel("Dictate")
      .accessibilityHint("Hold to talk, or tap to start. Transcribed on your Mac.")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { start() }
      .accessibilityIdentifier("chat.mic")
  }
}

/// While recording: cancel, the live level, the time, done. While transcribing: what is happening.
struct RecordingBar: View {
  let voice: VoiceCapture
  let done: () -> Void
  let cancel: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Button(action: cancel) {
        Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(Theme.text)
          .frame(width: 40, height: 40).background(Theme.card, in: Circle())
          .overlay(Circle().strokeBorder(Theme.border, lineWidth: 0.5))
      }
      .buttonStyle(PressStyle())
      .disabled(voice.phase != .recording)
      .opacity(voice.phase == .recording ? 1 : 0.4)
      .accessibilityLabel("Cancel the recording")
      .accessibilityIdentifier("voice.cancel")
      HStack(spacing: 10) {
        if voice.phase == .recording {
          Circle().fill(Theme.error).frame(width: 8, height: 8)
          Wave(levels: voice.levels).frame(height: 26)
          TimelineView(.periodic(from: .now, by: 1)) { _ in
            Text(String(format: "%d:%02d", voice.seconds / 60, voice.seconds % 60)).font(.subheadline.monospacedDigit()).foregroundStyle(Theme.dim)
          }
        } else {
          ProgressView().controlSize(.small)
          Text("Transcribing on your Mac").font(.subheadline).foregroundStyle(Theme.dim)
          Spacer(minLength: 0)
        }
      }
      .padding(.horizontal, 14).frame(height: 42)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(voice.phase == .recording ? Theme.error.opacity(0.35) : Theme.border, lineWidth: 0.5))
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(voice.phase == .recording ? "voice.recording" : "voice.transcribing")
      Button(action: done) {
        Image(systemName: "checkmark").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.onPrimary)
          .frame(width: 40, height: 40).background(Theme.primary, in: Circle())
      }
      .buttonStyle(PressStyle())
      .disabled(voice.phase != .recording)
      .opacity(voice.phase == .recording ? 1 : 0.4)
      .accessibilityLabel("Done: transcribe")
      .accessibilityIdentifier("voice.done")
    }
  }
}

/// The level, as bars.
struct Wave: View {
  let levels: [Float]
  var body: some View {
    GeometryReader { g in
      let n = levels.count
      let w = g.size.width / CGFloat(max(1, n))
      HStack(alignment: .center, spacing: w * 0.35) {
        ForEach(0..<n, id: \.self) { i in
          Capsule().fill(Theme.text.opacity(0.75))
            .frame(width: w * 0.65, height: max(3, g.size.height * CGFloat(levels[i])))
        }
      }
      .frame(maxHeight: .infinity)
      .animation(.linear(duration: 0.05), value: levels)
    }
  }
}
