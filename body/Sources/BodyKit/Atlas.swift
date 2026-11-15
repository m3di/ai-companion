import Foundation

// The Atlas is the bot's live surface (src/atlas.ts): JSON endpoints and one
// server-sent-events stream of PULSES. The body reads it exactly as the web
// Atlas does — the app never proxies or stores what it shows (I1/I2: the
// canvas is a render).

/// One line on `/api/stream` (src/pulse.ts `Pulse`).
public struct Pulse: Decodable, Identifiable, Equatable, Sendable {
  public let seq: Int
  public let at: String
  public let kind: String
  public let text: String
  public let refs: [String]?
  public let domains: [String]?
  public var id: Int { seq }
  public init(seq: Int, at: String, kind: String, text: String, refs: [String]? = nil, domains: [String]? = nil) {
    self.seq = seq; self.at = at; self.kind = kind; self.text = text; self.refs = refs; self.domains = domains
  }
}

/// `/api/vitals` (src/vitals.ts). Every field optional: a vitals shape that
/// grows must not blank the widget.
public struct Vitals: Decodable, Sendable {
  public struct Graph: Decodable, Sendable { public var entities: Int?; public var domains: Int?; public var open: Int?; public var lintErrors: Int?; public var rot: Int?; public var rotAt: String? }
  public struct Memory: Decodable, Sendable {
    public struct Goals: Decodable, Sendable { public var open: Int?; public var asked: Int?; public var parked: Int? }
    public var pendingObservations: Int?; public var oldestObservation: String?; public var proposals: Int?
    public var openFriction: Int?; public var frictionLast24h: Int?; public var goalQuestions: Goals?
  }
  public struct Day: Decodable, Sendable { public var messages24h: Int?; public var focusOpen: Int?; public var conciergeSince: String?; public var contextChars: Int? }
  public struct Night: Decodable, Sendable {
    public struct Settled: Decodable, Sendable { public var boundary: String?; public var how: String? }
    public var dreams: Int?; public var lastDream: String?; public var hoursSinceDream: Double?; public var settled: Settled?
  }
  public var mode: String?
  public var graph: Graph?
  public var memory: Memory?
  public var day: Day?
  public var night: Night?
}

/// `/api/polish` reply.
public struct Polished: Decodable, Sendable {
  public var text: String
  public var ms: Int
}

/// `/api/mode`.
public struct Mode: Decodable, Sendable {
  public var mode: String
}

/// `/api/lens/<name>` (src/lens.ts): a titled list over the store.
public struct Lens: Decodable, Sendable {
  public struct Row: Decodable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var ref: String?
  }
  public var name: String
  public var title: String
  public var hint: String?
  public var rows: [Row]
}

/// Server-sent events, the parsing half only — pure, so it is testable without
/// a socket. Feed lines; get events. Comment lines (`: beat`) are heartbeats and
/// are reported as such, because "the stream is silent" and "the stream is
/// alive and quiet" are two different facts.
public struct SSEParser: Sendable {
  public enum Event: Equatable, Sendable {
    case data(String)
    case heartbeat
  }
  private var data: [String] = []
  public init() {}

  /// One line, without its newline. Returns an event when a line completes one.
  public mutating func feed(line: String) -> Event? {
    if line.isEmpty {
      guard !data.isEmpty else { return nil }
      let joined = data.joined(separator: "\n")
      data.removeAll()
      return .data(joined)
    }
    if line.hasPrefix(":") { return .heartbeat }
    if line.hasPrefix("data:") {
      var v = line.dropFirst(5)
      if v.hasPrefix(" ") { v = v.dropFirst() }
      data.append(String(v))
    }
    // `event:`/`id:`/`retry:` are not used by src/atlas.ts; ignored on purpose.
    return nil
  }
}

/// The client. Base URL from `COMPANION_ATLAS` or `--atlas`, default the Atlas's
/// own port (`ATLAS_PORT` in the bot's .env).
public final class AtlasClient: Sendable {
  public let base: URL
  private let session: URLSession
  /// For calls that run a model on the other end: the deep polish takes
  /// 30–60 s through the bot's CLI path, and the default session's 15 s cap
  /// cut it off (NSURLErrorDomain −1001, 2026-10-05). The configuration's
  /// timeout wins over the request's, so a long call needs its own session.
  private let longSession: URLSession
  public static let longTimeout: TimeInterval = 180

  public init(base: URL) {
    self.base = base
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 15
    cfg.timeoutIntervalForResource = 60 * 60 * 24
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: cfg)
    let long = URLSessionConfiguration.default
    long.timeoutIntervalForRequest = AtlasClient.longTimeout
    long.timeoutIntervalForResource = AtlasClient.longTimeout
    long.requestCachePolicy = .reloadIgnoringLocalCacheData
    longSession = URLSession(configuration: long)
  }

  public static let defaultBase = URL(string: "http://127.0.0.1:7391")!
  /// `BODY_DEBUG=1`: the stream narrates itself on stderr.
  private var debug: Bool { ProcessInfo.processInfo.environment["BODY_DEBUG"] != nil }

  public func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
    let (data, resp) = try await transport(path) { try await session.data(from: base.appending(path: path)) }
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw AtlasError.status((resp as? HTTPURLResponse)?.statusCode ?? -1, path)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }

  /// POST a JSON body, decode a JSON reply. The polish uses it; later the turn.
  public func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
    var req = URLRequest(url: base.appending(path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await transport(path) { try await longSession.data(for: req) }
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
      throw AtlasError.status((resp as? HTTPURLResponse)?.statusCode ?? -1, msg.map { "\(path): \($0)" } ?? path)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }

  /// The stream, as an async sequence of events. Ends when the server closes;
  /// the caller reconnects (AppState does, with backoff), because a stream
  /// that silently never resumes is the failure the connection chip exists for.
  public func stream() -> AsyncThrowingStream<SSEParser.Event, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var req = URLRequest(url: base.appending(path: "/api/stream"))
          req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
          let (bytes, resp) = try await session.bytes(for: req)
          guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw AtlasError.status((resp as? HTTPURLResponse)?.statusCode ?? -1, "/api/stream")
          }
          if debug { FileHandle.standardError.write(Data("stream: \(http.statusCode) \(http.allHeaderFields)\n".utf8)) }
          // Bytes, not `.lines`: split on LF ourselves so a chunk that ends
          // mid-line is held, and nothing waits for a buffer to fill.
          var parser = SSEParser()
          var buf: [UInt8] = []
          var n = 0
          for try await b in bytes {
            n += 1
            if debug, n == 1 { FileHandle.standardError.write(Data("stream: first byte\n".utf8)) }
            if b == 0x0A {
              let line = String(decoding: buf, as: UTF8.self)
              buf.removeAll(keepingCapacity: true)
              if let ev = parser.feed(line: line) { continuation.yield(ev) }
            } else if b != 0x0D {
              buf.append(b)
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}

/// A URL loading failure, said in words a person can act on.
private func transport<T>(_ path: String, _ body: () async throws -> T) async throws -> T {
  do {
    return try await body()
  } catch let e as URLError {
    throw AtlasError.transport(path, e)
  }
}

public enum AtlasError: Error, CustomStringConvertible {
  case status(Int, String)
  case transport(String, URLError)
  public var description: String {
    switch self {
    case let .status(code, path): return "HTTP \(code) on \(path)"
    case let .transport(path, e):
      switch e.code {
      case .timedOut: return "\(path) timed out (\(Int(AtlasClient.longTimeout)) s) — the bot did not answer in time"
      case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost: return "\(path): the bot is not reachable — is npm run start running?"
      default: return "\(path): \(e.localizedDescription) (URLError \(e.code.rawValue))"
      }
    }
  }
}
