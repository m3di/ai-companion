import AVFoundation
import Foundation
import Speech

// THE EAR — microphone (or a file) → SpeechAnalyzer → words with confidences,
// as they arrive. Lifted from reflex's Ear.swift (its pipeline, verified over
// files and live on the M5), with two additions the take view wanted and the
// tap already paid for: the audio is written to a file as it is heard, so a
// take can be played back, and a loudness history is kept, so it can be
// drawn. It only hears; what the words mean is the stage's business.

public struct Word: Hashable, Sendable, Codable {
  /// As the transcriber gave it, leading space included — joining the words gives the text back exactly.
  public let text: String
  public let confidence: Double?
  public init(text: String, confidence: Double?) { self.text = text; self.confidence = confidence }

  /// sure ≥ 0.8 · unsure ≥ 0.5 · guess below · nil = not scored (volatile, or whitespace)
  public var grade: Grade {
    switch confidence {
    case .some(let c) where c < 0.5: return .guess
    case .some(let c) where c < 0.8: return .unsure
    case .some: return .sure
    case .none: return .unscored
    }
  }
  public enum Grade: Sendable { case sure, unsure, guess, unscored }
}

/// Loudness from the audio thread, read by the UI at its own pace; the history
/// is one RMS per buffer (~43 ms at 48 kHz / 2048), capped.
public final class Level: @unchecked Sendable {
  private let lock = NSLock()
  private var rms = 0.0
  private var hist: [Float] = []
  public static let historyCap = 2400   // ~100 s
  public var value: Double { lock.lock(); defer { lock.unlock() }; return rms }
  public var history: [Float] { lock.lock(); defer { lock.unlock() }; return hist }
  public func set(_ x: Double) {
    lock.lock()
    rms = x
    hist.append(Float(x))
    if hist.count > Level.historyCap { hist.removeFirst(hist.count - Level.historyCap) }
    lock.unlock()
  }
  public func reset() { lock.lock(); rms = 0; hist.removeAll(); lock.unlock() }
}

@MainActor public final class Ear {
  public enum Event: Sendable {
    case preparing(String)
    case listening(String)                     // locale
    case result(words: [Word], isFinal: Bool)
    case finished                              // a file ran out, or the mic was stopped and the tail finalized
    case failed(String)
  }

  public let level = Level()
  public var onEvent: (Event) -> Void = { _ in }
  /// Where the take is being written, while the mic is open.
  public private(set) var recordingURL: URL?

  private var engine: AVAudioEngine?
  private var feed: AsyncStream<AnalyzerInput>.Continuation?
  private var analyzer: SpeechAnalyzer?
  private var reader: Task<Void, Never>?
  private var recording: AVAudioFile?

  public init() {}

  /// Open the microphone, or run a file through the same pipeline (a test;
  /// `recordTo` is ignored for a file).
  public func start(file: URL? = nil, recordTo: URL? = nil, locale wanted: Locale = Locale(identifier: "en-US")) async {
    guard SpeechTranscriber.isAvailable else { return onEvent(.failed("SpeechTranscriber is not available on this Mac")) }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      return onEvent(.failed("\(wanted.identifier) is not a supported language"))
    }
    if file == nil {
      guard await AVCaptureDevice.requestAccess(for: .audio) else {
        return onEvent(.failed("Microphone access is off — System Settings › Privacy & Security › Microphone"))
      }
    }

    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence])
    let modules: [any SpeechModule] = [transcriber]
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        onEvent(.preparing("Downloading the \(locale.identifier(.bcp47)) speech model…"))
        try await request.downloadAndInstall()
      }
    } catch {
      return onEvent(.failed("Could not install the speech model: \(error.localizedDescription)"))
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
      return onEvent(.failed("No audio format the transcriber accepts"))
    }

    let analyzer = SpeechAnalyzer(modules: modules)
    self.analyzer = analyzer
    reader = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          self?.onEvent(.result(words: Self.words(of: result.text), isFinal: result.isFinal))
        }
        self?.onEvent(.finished)
      } catch {
        self?.onEvent(.failed("Transcription failed: \(error.localizedDescription)"))
      }
    }

    if let file {
      do {
        let audio = try AVAudioFile(forReading: file)
        onEvent(.listening(locale.identifier(.bcp47)))
        try await analyzer.start(inputAudioFile: audio, finishAfterFile: true)
      } catch {
        onEvent(.failed("Could not read \(file.lastPathComponent): \(error.localizedDescription)"))
      }
      return
    }

    let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
    self.feed = feed
    let engine = AVAudioEngine()
    self.engine = engine
    let micFormat = engine.inputNode.outputFormat(forBus: 0)
    guard micFormat.sampleRate > 0, let converter = AVAudioConverter(from: micFormat, to: format) else {
      return onEvent(.failed("No microphone, or its format cannot be converted"))
    }
    // The take, as heard: CAF in the mic's own format, written buffer by buffer.
    if let url = recordTo {
      try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      recording = try? AVAudioFile(forWriting: url, settings: micFormat.settings)
      recordingURL = recording == nil ? nil : url
    }
    let level = self.level
    level.reset()
    let recording = self.recording
    engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: micFormat) { buffer, _ in
      if let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 {
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        level.set(Double((sum / Float(buffer.frameLength)).squareRoot()))
      }
      try? recording?.write(from: buffer)
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / micFormat.sampleRate) + 32
      guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
      var handedOver = false
      var error: NSError?
      converter.convert(to: out, error: &error) { _, status in
        if handedOver {
          status.pointee = .noDataNow
          return nil
        }
        handedOver = true
        status.pointee = .haveData
        return buffer
      }
      guard error == nil, out.frameLength > 0 else { return }
      feed.yield(AnalyzerInput(buffer: out))
    }
    do {
      try engine.start()
      try await analyzer.start(inputSequence: stream)
      onEvent(.listening(locale.identifier(.bcp47)))
    } catch {
      onEvent(.failed("Could not start listening: \(error.localizedDescription)"))
    }
  }

  /// Closes the microphone. What was being said is finalized, not dropped:
  /// the last results arrive, then `.finished`.
  public func stop() {
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    engine = nil
    feed?.finish()
    feed = nil
    recording = nil   // closes the file
    let analyzer = self.analyzer
    self.analyzer = nil
    Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
  }

  /// One Word per run, the whitespace before it folded in.
  static func words(of text: AttributedString) -> [Word] {
    var out: [Word] = [], space = ""
    for run in text.runs {
      let piece = String(text[run.range].characters)
      if piece.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        space += piece
        continue
      }
      out.append(Word(text: space + piece, confidence: run.transcriptionConfidence))
      space = ""
    }
    if space.contains(where: \.isNewline) { out.append(Word(text: space, confidence: nil)) }
    return out
  }
}
