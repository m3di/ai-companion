import AppKit
import AVFoundation
import BodyKit
import Observation
import SwiftUI

// A TAKE — one press of the microphone: click to start, click to stop. Fully
// manual, as asked. While it runs, the words arrive colour-coded by
// confidence and the loudness draws itself; when it stops, the tail is
// finalized, the audio is on disk, and the take can be inspected and played
// back before anything is sent (part 3 sends it).

@MainActor @Observable
final class Take {
  enum Phase: Equatable { case idle, preparing(String), listening, finishing, done, failed(String) }

  let ear = Ear()
  let polisher = OnDevicePolisher()
  let state: AppState
  let store: TakeStore
  private(set) var id: String?
  var phase: Phase = .idle
  /// Final sentences so far, in order.
  var lines: [[Word]] = []
  /// The sentence still moving under the voice.
  var volatile: [Word] = []
  var levels: [Float] = []
  var audio: URL?
  var startedAt: Date?
  var stoppedAt: Date?
  /// The text he meant, as the cheap model last wrote it — the thing shown.
  var polished = ""
  var polishing = false
  var passes = 0
  var lastPassMs = 0
  var polishError: String?
  /// The bot's Haiku pass landed over the on-device one (asked for; 30–50 s).
  var deep = false
  var deepening = false
  /// The raw, graded words behind the polish — one click away.
  var showRaw = false
  private var player: AVAudioPlayer?
  private var meter: Task<Void, Never>?
  private var pauseTimer: Task<Void, Never>?
  private var passInFlight: Task<Void, Never>?
  private var passWanted = false
  /// Silence after a final result before a pass fires.
  static let pauseSeconds = 1.5

  init(state: AppState, store: TakeStore = TakeStore()) {
    self.state = state
    self.store = store
    ear.onEvent = { [weak self] e in self?.handle(e) }
    restoreLatest()
  }

  /// The last take comes back on launch, finished, with its audio and polish.
  private func restoreLatest() {
    guard let last = store.latestId(), let saved = store.load(last) else { return }
    id = saved.id
    lines = saved.lines
    polished = saved.polished
    passes = saved.passes
    deep = saved.deep
    startedAt = saved.startedAt
    stoppedAt = saved.stoppedAt
    let audio = store.audioURL(saved.id)
    self.audio = FileManager.default.fileExists(atPath: audio.path) ? audio : nil
    phase = lines.isEmpty ? .idle : .done
    state.note("take", "restored take \(saved.id): \(wordCount) word(s), \(saved.polished.isEmpty ? "no polish" : "polished")")
  }

  private func persist() {
    guard let id else { return }
    let st = state
    store.save(SavedTake(id: id, startedAt: startedAt ?? Date(), stoppedAt: stoppedAt, lines: lines, polished: polished, passes: passes, deep: deep)) { url in
      if url.lastPathComponent.hasPrefix("FAILED") { Task { @MainActor in st.note("take", url.lastPathComponent) } }
    }
  }

  var isListening: Bool { if case .listening = phase { return true }; return false }
  var text: String { (lines.map { $0.map(\.text).joined() } + [volatile.map(\.text).joined()]).joined(separator: " ").trimmingCharacters(in: .whitespaces) }
  var wordCount: Int { lines.reduce(0) { $0 + $1.count } + volatile.count }
  var seconds: Double { guard let s = startedAt else { return 0 }; return (stoppedAt ?? Date()).timeIntervalSince(s) }

  func toggle() {
    switch phase {
    case .listening: stop()
    case .preparing, .finishing: break
    default: start()
    }
  }

  func start() {
    lines = []; volatile = []; levels = []; audio = nil; stoppedAt = nil
    polished = ""; passes = 0; lastPassMs = 0; polishError = nil; showRaw = false; deep = false; deepening = false
    pauseTimer?.cancel(); passInFlight?.cancel(); passWanted = false
    Task { await polisher.warm() }
    phase = .preparing("Opening the microphone…")
    startedAt = Date()
    let newId = TakeStore.newId()
    id = newId
    let url = store.audioURL(newId)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    state.note("ear", "take \(newId) started — \(url.deletingLastPathComponent().path)")
    meter = Task { [weak self] in
      // 20 Hz: the meter and the waveform read the tap's history at their own pace.
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(50))
        guard let self else { return }
        self.levels = self.ear.level.history
      }
    }
    Task { await ear.start(recordTo: url) }
  }

  func stop() {
    phase = .finishing
    stoppedAt = Date()
    ear.stop()
    meter?.cancel()
    levels = ear.level.history
    audio = ear.recordingURL
    state.note("ear", "take stopped after \(String(format: "%.1f", seconds)) s · \(wordCount) word(s) so far")
    persist()
  }

  func clear() {
    player?.stop()
    pauseTimer?.cancel(); passInFlight?.cancel(); passWanted = false
    if let id { store.delete(id); state.note("take", "discarded take \(id)") }
    id = nil
    lines = []; volatile = []; levels = []; audio = nil; startedAt = nil; stoppedAt = nil
    polished = ""; polishing = false; passes = 0; polishError = nil; showRaw = false; deep = false; deepening = false
    phase = .idle
  }

  /// The polished text, or the raw while there is none yet.
  var display: String { polished.isEmpty ? text : polished }

  // MARK: the polish — a pass on every pause, one more at the end

  private func schedulePass(after seconds: Double) {
    pauseTimer?.cancel()
    pauseTimer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
      guard !Task.isCancelled, let self else { return }
      self.requestPass()
    }
  }

  /// One pass at a time, ON DEVICE (0.8 s measured); a request during a pass
  /// runs once it ends, over everything said by then — passes never pile up.
  private func requestPass() {
    guard !lines.isEmpty else { return }
    if passInFlight != nil { passWanted = true; return }
    passWanted = false
    polishing = true
    let raw = lines.flatMap { $0 }
    let previous = polished
    passInFlight = Task { [weak self] in
      guard let self else { return }
      let t0 = Date()
      do {
        let text = try await self.polisher.polish(raw: raw, previous: previous)
        if !Task.isCancelled, !text.isEmpty {
          self.polished = text
          self.passes += 1
          self.lastPassMs = Int(Date().timeIntervalSince(t0) * 1000)
          self.polishError = nil
          self.deep = false
          self.state.note("polish", "pass \(self.passes) on device: \(self.lastPassMs) ms, \(text.count) chars")
          self.persist()
        }
      } catch {
        self.polishError = "\(error)"
        self.state.note("polish", "FAILED: \(error)")
      }
      self.passInFlight = nil
      self.polishing = false
      if self.passWanted { self.requestPass() }
    }
  }

  /// THE DEEP PASS — the bot's Haiku (src/polish.ts): the one that drops
  /// fillers and applies a spoken correction. 30–50 s and ~3 cents through
  /// the CLI the bot reaches Claude by, so it is asked for, not automatic;
  /// with an API key on the bot it would be ~1 s and automatic.
  func deepPolish() {
    guard !lines.isEmpty, !deepening else { return }
    deepening = true
    let raw = lines.flatMap { $0 }.map { ["text": $0.text, "confidence": $0.confidence as Any] }
    let previous = polished
    state.note("polish", "deep pass asked of the bot")
    Task { [weak self] in
      guard let self else { return }
      do {
        let r = try await self.state.atlas.post("/api/polish", body: ["raw": raw, "previous": previous], as: Polished.self)
        if !r.text.isEmpty {
          self.polished = r.text
          self.lastPassMs = r.ms
          self.deep = true
          self.polishError = nil
          self.state.note("polish", "deep pass landed: \(r.ms) ms, \(r.text.count) chars")
          self.persist()
        }
      } catch {
        self.polishError = "deep: \(error)"
        self.state.note("polish", "deep pass FAILED: \(error)")
      }
      self.deepening = false
    }
  }

  func play() {
    guard let audio, player?.isPlaying != true else { player?.stop(); return }
    player = try? AVAudioPlayer(contentsOf: audio)
    player?.play()
    state.note("ear", "playing the take back")
  }
  var isPlaying: Bool { player?.isPlaying == true }

  /// The file test routes events through the same handler and prints beside it.
  func handleForTest(_ e: Ear.Event) { handle(e) }

  private func handle(_ e: Ear.Event) {
    switch e {
    case let .preparing(s): phase = .preparing(s); state.note("ear", s)
    case let .listening(locale): phase = .listening; state.note("ear", "listening (\(locale))")
    case let .result(words, isFinal):
      if isFinal {
        if !words.isEmpty { lines.append(words); persist() }
        volatile = []
        // A sentence ended; if nothing follows for a pause, polish what there is.
        if isListening { schedulePass(after: Take.pauseSeconds) }
      } else {
        volatile = words
        pauseTimer?.cancel()   // he is still talking
      }
    case .finished:
      if !volatile.isEmpty { lines.append(volatile); volatile = [] }
      phase = lines.isEmpty ? .idle : .done
      state.note("ear", "finalized: \(wordCount) word(s), \(lines.count) sentence(s)")
      persist()
      pauseTimer?.cancel()
      requestPass()   // the final pass, over everything
    case let .failed(s):
      phase = .failed(s)
      meter?.cancel()
      state.note("ear", "FAILED: \(s)")
    }
  }
}

/// The take, drawn. While he talks: the waveform and a count, nothing to
/// read or correct. After: the polished text, selectable and copyable, with
/// the raw graded words one click away.
struct TakeView: View {
  let take: Take
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: take.polishing ? "sparkles" : "waveform").foregroundStyle(take.polishing ? Palette.stage : .secondary)
          .symbolEffect(.pulse, isActive: take.polishing)
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        Text(meta).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
        if !take.isListening, !take.lines.isEmpty {
          Button { take.showRaw.toggle() } label: { Image(systemName: take.showRaw ? "text.quote" : "waveform.and.magnifyingglass") }
            .help(take.showRaw ? "Show the polished text" : "Inspect the raw words and their confidence")
          Button { copy() } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }.help("Copy the text")
          Button { take.deepPolish() } label: { Image(systemName: take.deepening ? "hourglass" : "wand.and.stars").foregroundStyle(take.deep ? Palette.stage : .secondary) }
            .disabled(take.deepening)
            .help(take.deep ? "Deep polish landed (the bot's model)" : "Deep polish by the bot's model — drops fillers, applies corrections; 30–50 s")
        }
        if take.audio != nil, !take.isListening {
          Button { take.play() } label: { Image(systemName: take.isPlaying ? "stop.fill" : "play.fill") }.help("Play the take back")
        }
        if !take.isListening {
          Button { take.clear() } label: { Image(systemName: "xmark") }.help("Discard the take")
        }
      }
      .font(.caption).buttonStyle(.plain)
      Waveform(levels: take.levels, live: take.isListening)
        .frame(height: take.isListening ? 56 : 28)
      if !take.isListening {
        if take.showRaw { rawWords; Legend() } else { polishedText }
        if let e = take.polishError {
          Text("polish failed — \(e)").font(.caption).foregroundStyle(Palette.guess).textSelection(.enabled)
        }
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(0.04)))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(take.isListening ? Palette.guess.opacity(0.5) : Color.primary.opacity(0.07)))
  }

  private var title: String {
    switch take.phase {
    case .idle: return "Take"
    case let .preparing(s): return s
    case .listening: return "Listening — click the microphone to stop"
    case .finishing: return "Finalizing…"
    case .done: return take.polishing ? "Polishing…" : take.showRaw ? "Raw — as heard" : take.polished.isEmpty ? "As heard" : take.deep ? "What you said — deep polish" : "What you said"
    case let .failed(s): return s
    }
  }

  private var meta: String {
    var parts = [String(format: "%.1f s · %d words", take.seconds, take.wordCount)]
    if take.passes > 0 { parts.append("\(take.deep ? "deep" : "pass \(take.passes)") · \(take.lastPassMs) ms") }
    if take.deepening { parts.append("deep pass running…") }
    return parts.joined(separator: " · ")
  }

  private var polishedText: some View {
    Text(take.display)
      .font(.body)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(minHeight: 24)
      .opacity(take.polishing && take.polished.isEmpty ? 0.5 : 1)
  }

  private var rawWords: some View {
    let text = take.lines.reduce(Text("")) { acc, line in
      line.reduce(acc) { $0 + Text($1.text).foregroundStyle(Palette.grade($1.grade)) }
    }
    return text
      .font(.body)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func copy() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(take.showRaw ? take.text : take.display, forType: .string)
    take.state.note("hand", "copied the \(take.showRaw ? "raw" : "polished") text (\(take.display.count) chars)")
    copied = true
    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
  }
}

/// Loudness over time, newest at the right; a live take scrolls, a finished
/// one shows the whole thing.
struct Waveform: View {
  let levels: [Float]
  let live: Bool
  var body: some View {
    Canvas { ctx, size in
      guard !levels.isEmpty else { return }
      let bars = Int(size.width / 3)
      let slice: [Float] = live ? Array(levels.suffix(bars)) : levels
      let step = max(1, slice.count / max(bars, 1))
      let peak = max(slice.max() ?? 0.01, 0.01)
      var x: CGFloat = 0
      var i = 0
      while i < slice.count, x < size.width {
        let chunk = slice[i..<min(i + step, slice.count)]
        let v = CGFloat((chunk.max() ?? 0) / peak)
        let h = max(2, v * size.height)
        ctx.fill(Path(roundedRect: CGRect(x: x, y: (size.height - h) / 2, width: 2, height: h), cornerRadius: 1), with: .color(live ? Palette.guess.opacity(0.8) : .secondary.opacity(0.6)))
        x += 3
        i += step
      }
    }
  }
}

struct Legend: View {
  var body: some View {
    HStack(spacing: 10) {
      ForEach([("sure", Palette.sure), ("unsure", Palette.unsure), ("guess", Palette.guess), ("still moving", Palette.volatile)], id: \.0) { name, color in
        HStack(spacing: 4) { Circle().fill(color).frame(width: 6, height: 6); Text(name) }
      }
    }
    .font(.caption2).foregroundStyle(.tertiary)
  }
}

/// The microphone button in the prompt bar: red while listening, with the
/// live level as a ring.
struct MicButton: View {
  let take: Take
  var body: some View {
    Button { take.toggle() } label: {
      ZStack {
        Circle().strokeBorder(Palette.guess.opacity(take.isListening ? 0.9 : 0), lineWidth: 2)
          .scaleEffect(1 + CGFloat(min(take.ear.level.value * 6, 0.6)))
        Image(systemName: take.isListening ? "stop.fill" : "mic.fill")
          .foregroundStyle(take.isListening ? Palette.guess : .secondary)
      }
      .frame(width: 26, height: 26)
    }
    .buttonStyle(.plain)
    .disabled({ if case .preparing = take.phase { return true }; if case .finishing = take.phase { return true }; return false }())
    .help(take.isListening ? "Stop listening" : "Start listening (click again to stop)")
  }
}
