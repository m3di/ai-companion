import Foundation
import Observation

// The app's own state, and the log of it — the OBSERVABILITY the first part
// is for. Everything here is about the body: whether it is connected, what it
// received, where it saved the layout, what the hand did. Nothing here is
// about the bot: that is read live and shown, never kept.

public struct LogLine: Identifiable, Sendable {
  public let id: Int
  public let at: Date
  public let tag: String
  public let text: String
}

public enum Connection: Equatable, Sendable {
  case connecting
  case live(since: Date)
  case lost(since: Date, error: String)

  public var label: String {
    switch self {
    case .connecting: return "connecting"
    case .live: return "live"
    case .lost: return "lost"
    }
  }
}

@MainActor @Observable
public final class AppState {
  public let atlas: AtlasClient
  public let started = Date()

  // Connection and the stream.
  public private(set) var connection: Connection = .connecting
  public private(set) var reconnects = 0
  public private(set) var lastHeartbeat: Date?
  public private(set) var lastSeq: Int?
  public private(set) var pulses: [Pulse] = []
  public private(set) var pulseTimes: [Date] = []
  public var pulsesPerMinute: Int {
    let cutoff = Date().addingTimeInterval(-60)
    return pulseTimes.filter { $0 > cutoff }.count
  }

  // What the bot says about itself, refetched on the pulses that move it.
  public private(set) var vitals: Vitals?
  public private(set) var vitalsAt: Date?
  public private(set) var lenses: [String: Lens] = [:]
  public private(set) var lensAt: [String: Date] = [:]
  public private(set) var fetchErrors = 0

  // The body's own facts.
  public private(set) var presence = PresenceProbe.sample()
  public private(set) var log: [LogLine] = []
  private var logSeq = 0
  public private(set) var layoutURL: URL?
  public private(set) var layoutSavedAt: Date?

  public static let pulseCap = 300
  public static let logCap = 400

  public init(atlas: AtlasClient) {
    self.atlas = atlas
    note("app", "started · atlas \(atlas.base.absoluteString)")
  }

  public func note(_ tag: String, _ text: String) {
    logSeq += 1
    log.append(LogLine(id: logSeq, at: Date(), tag: tag, text: text))
    if log.count > AppState.logCap { log.removeFirst(log.count - AppState.logCap) }
  }

  public func layoutSaved(_ url: URL) {
    layoutURL = url
    layoutSavedAt = Date()
    note("layout", url.lastPathComponent.hasPrefix("FAILED") ? url.lastPathComponent : "saved")
  }

  // MARK: the stream

  /// Connect, and stay connected: a closed or failed stream is reopened with a
  /// backoff that resets on the first event. Runs for the life of the app.
  public func run() {
    Task { await streamForever() }
    Task { await pollPresence() }
    Task { await refreshVitals(); for lens in ["focus", "friction", "observations", "nights"] { await refreshLens(lens) } }
  }

  private func streamForever() async {
    var backoff: Double = 1
    while !Task.isCancelled {
      connection = .connecting
      var sawEvent = false
      do {
        for try await ev in atlas.stream() {
          if !sawEvent {
            sawEvent = true
            backoff = 1
            connection = .live(since: Date())
            note("stream", reconnects == 0 ? "connected" : "reconnected (#\(reconnects))")
          }
          switch ev {
          case .heartbeat:
            lastHeartbeat = Date()
          case let .data(json):
            handle(json)
          }
        }
        note("stream", "closed by the server")
      } catch {
        note("stream", "lost: \(error)")
        connection = .lost(since: Date(), error: "\(error)")
      }
      reconnects += 1
      try? await Task.sleep(for: .seconds(backoff))
      backoff = min(backoff * 2, 30)
    }
  }

  private func handle(_ json: String) {
    guard let data = json.data(using: .utf8), let p = try? JSONDecoder().decode(Pulse.self, from: data) else {
      note("stream", "unreadable line: \(json.prefix(80))")
      return
    }
    // The stream replays recent pulses on connect; dedupe on seq.
    if let last = lastSeq, p.seq <= last { return }
    lastSeq = p.seq
    lastHeartbeat = Date()
    pulses.append(p)
    pulseTimes.append(Date())
    if pulses.count > AppState.pulseCap { pulses.removeFirst(pulses.count - AppState.pulseCap) }
    if pulseTimes.count > 600 { pulseTimes.removeFirst(pulseTimes.count - 600) }
    // What moved, refetch — the lenses are renders of the store the pulse says changed.
    switch p.kind {
    case "entity-change", "write", "run", "operator", "mode", "night":
      Task { await refreshVitals(); await refreshLens("focus"); await refreshLens("observations") }
    case "focus":
      Task { await refreshLens("focus") }
    case "friction":
      Task { await refreshLens("friction") }
    default:
      break
    }
  }

  // MARK: fetches

  public func refreshVitals() async {
    do {
      vitals = try await atlas.get("/api/vitals", as: Vitals.self)
      vitalsAt = Date()
    } catch {
      fetchErrors += 1
      note("fetch", "vitals: \(error)")
    }
  }

  public func refreshLens(_ name: String) async {
    do {
      lenses[name] = try await atlas.get("/api/lens/\(name)", as: Lens.self)
      lensAt[name] = Date()
    } catch {
      fetchErrors += 1
      note("fetch", "lens \(name): \(error)")
    }
  }

  // MARK: presence

  private func pollPresence() async {
    while !Task.isCancelled {
      let s = PresenceProbe.sample()
      if s.presence != presence.presence { note("presence", "\(presence.presence.rawValue) → \(s.presence.rawValue)") }
      presence = s
      try? await Task.sleep(for: .seconds(5))
    }
  }
}
