import Foundation

// WHERE A TAKE LIVES. On 2026-10-05 a three-minute take sat in the app's
// memory while a restart was needed, and the only copy was the audio in
// /tmp. Now a take is a FOLDER under Application Support from the moment the
// microphone opens — the audio written into it as heard, the words and the
// polish saved on every change — and the last one comes back on launch.
// Discard deletes the folder. Test runs get a scratch store.

public struct SavedTake: Codable, Sendable {
  public var id: String
  public var startedAt: Date
  public var stoppedAt: Date?
  public var lines: [[Word]]
  public var polished: String
  public var passes: Int
  public var deep: Bool
  public init(id: String, startedAt: Date, stoppedAt: Date?, lines: [[Word]], polished: String, passes: Int, deep: Bool) {
    self.id = id; self.startedAt = startedAt; self.stoppedAt = stoppedAt; self.lines = lines; self.polished = polished; self.passes = passes; self.deep = deep
  }
}



public final class TakeStore: @unchecked Sendable {
  public let root: URL
  private var pending: Task<Void, Never>?
  private let lock = NSLock()

  public static var defaultRoot: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
      .appending(path: "Companion").appending(path: "takes")
  }

  public init(root: URL = TakeStore.defaultRoot) { self.root = root }

  public func folder(_ id: String) -> URL { root.appending(path: id) }
  public func audioURL(_ id: String) -> URL { folder(id).appending(path: "audio.caf") }
  private func metaURL(_ id: String) -> URL { folder(id).appending(path: "take.json") }

  /// Debounced: the last call within 300 ms is the one written.
  public func save(_ take: SavedTake, onWritten: (@Sendable (URL) -> Void)? = nil) {
    lock.lock(); defer { lock.unlock() }
    pending?.cancel()
    let url = metaURL(take.id)
    pending = Task.detached(priority: .utility) {
      try? await Task.sleep(for: .milliseconds(300))
      if Task.isCancelled { return }
      do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(take).write(to: url, options: .atomic)
        // The polished text as a plain file too — readable without the app.
        try take.polished.write(to: url.deletingLastPathComponent().appending(path: "polished.txt"), atomically: true, encoding: .utf8)
        onWritten?(url)
      } catch {
        onWritten?(url.appending(path: "FAILED: \(error.localizedDescription)"))
      }
    }
  }

  public func saveNow(_ take: SavedTake) throws {
    lock.lock(); pending?.cancel(); lock.unlock()
    let url = metaURL(take.id)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let enc = JSONEncoder()
    enc.dateEncodingStrategy = .iso8601
    try enc.encode(take).write(to: url, options: .atomic)
  }

  public func load(_ id: String) -> SavedTake? {
    guard let data = try? Data(contentsOf: metaURL(id)) else { return nil }
    let dec = JSONDecoder()
    dec.dateDecodingStrategy = .iso8601
    return try? dec.decode(SavedTake.self, from: data)
  }

  /// Folder names are timestamps, so the last by name is the last by time.
  public func latestId() -> String? {
    (try? FileManager.default.contentsOfDirectory(atPath: root.path))?
      .filter { !$0.hasPrefix(".") }
      .sorted()
      .last
  }

  public func delete(_ id: String) {
    lock.lock(); pending?.cancel(); lock.unlock()
    try? FileManager.default.removeItem(at: folder(id))
  }

  public static func newId(_ now: Date = Date()) -> String { String(Int(now.timeIntervalSince1970)) }
}
