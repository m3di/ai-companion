import CoreGraphics
import Foundation

// The layout: which widgets, in what order, which are folded to a pill. Where
// they go is the arrangement's decision (Arrange.swift), from the window.
// One JSON file under Application Support, written 400 ms after the last
// change. This is the ONLY state the body owns — everything a widget shows
// belongs to the bot.

public enum WidgetKind: String, Codable, CaseIterable, Sendable {
  case vitals, feed, focus, friction, observations, nights, appState

  public var title: String {
    switch self {
    case .vitals: return "Vitals"
    case .feed: return "Live feed"
    case .focus: return "Focus"
    case .friction: return "Friction"
    case .observations: return "Inbox"
    case .nights: return "Nights"
    case .appState: return "This app"
    }
  }

  /// SF Symbol for the pill and the title bar.
  public var symbol: String {
    switch self {
    case .vitals: return "waveform.path.ecg"
    case .feed: return "dot.radiowaves.left.and.right"
    case .focus: return "scope"
    case .friction: return "exclamationmark.triangle"
    case .observations: return "tray"
    case .nights: return "moon.stars"
    case .appState: return "gauge.with.dots.needle.33percent"
    }
  }

  /// The lens behind a list widget, when it is one.
  public var lens: String? {
    switch self {
    case .focus: return "focus"
    case .friction: return "friction"
    case .observations: return "observations"
    case .nights: return "nights"
    default: return nil
    }
  }
}

public struct WidgetSpec: Codable, Identifiable, Equatable, Sendable {
  public var id: String
  public var kind: WidgetKind
  public var collapsed: Bool

  public init(id: String, kind: WidgetKind, collapsed: Bool = false) {
    self.id = id; self.kind = kind; self.collapsed = collapsed
  }
}

public struct BoardLayout: Codable, Equatable, Sendable {
  public var version: Int
  public var widgets: [WidgetSpec]

  public init(version: Int = 2, widgets: [WidgetSpec]) {
    self.version = version; self.widgets = widgets
  }

  /// The first layout. Order is placement order: left, right, left, right.
  public static let initial = BoardLayout(widgets: [
    WidgetSpec(id: "vitals", kind: .vitals),
    WidgetSpec(id: "focus", kind: .focus),
    WidgetSpec(id: "feed", kind: .feed),
    WidgetSpec(id: "appState", kind: .appState),
  ])
}

/// Where the layout lives, and the debounced write.
public final class LayoutStore: @unchecked Sendable {
  public let url: URL
  private var pending: Task<Void, Never>?
  private let lock = NSLock()

  public static var defaultURL: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return base.appending(path: "Companion").appending(path: "layout.json")
  }

  public init(url: URL = LayoutStore.defaultURL) { self.url = url }

  /// A file from version 1 (frames) decodes as nil and the initial layout is used.
  public func load() -> BoardLayout? {
    guard let data = try? Data(contentsOf: url), let l = try? JSONDecoder().decode(BoardLayout.self, from: data), l.version >= 2 else { return nil }
    return l
  }

  /// Debounced: the last call within 400 ms is the one written. `onWritten`
  /// is how the app's own log learns that a save happened.
  public func save(_ layout: BoardLayout, onWritten: (@Sendable (URL) -> Void)? = nil) {
    lock.lock(); defer { lock.unlock() }
    pending?.cancel()
    let url = self.url
    pending = Task.detached(priority: .utility) {
      try? await Task.sleep(for: .milliseconds(400))
      if Task.isCancelled { return }
      do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(layout).write(to: url, options: .atomic)
        onWritten?(url)
      } catch {
        onWritten?(url.appending(path: "FAILED: \(error.localizedDescription)"))
      }
    }
  }

  /// Write now, no debounce — for the checks and for quitting.
  public func saveNow(_ layout: BoardLayout) throws {
    lock.lock(); pending?.cancel(); lock.unlock()
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(layout).write(to: url, options: .atomic)
  }
}
