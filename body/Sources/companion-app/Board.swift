import BodyKit
import Observation
import SwiftUI

// The board: the widget list, the window size, and the arrangement computed
// from the two. Nothing moves by hand; a pill can be opened and closed.

@MainActor @Observable
final class Board {
  let store: LayoutStore
  let state: AppState
  var layout: BoardLayout
  var windowSize: CGSize = .zero
  /// The one pill open as a popover, if any.
  var openPill: String?

  init(store: LayoutStore, state: AppState) {
    self.store = store
    self.state = state
    let loaded = store.load()
    layout = loaded ?? BoardLayout.initial
    state.note("layout", loaded == nil ? "no layout file (or an old one) — the initial widget set" : "loaded \(layout.widgets.count) widget(s) from \(store.url.lastPathComponent)")
  }

  var window: CGRect { CGRect(origin: .zero, size: windowSize) }
  var arrangement: Arrangement { arrange(window: window, widgets: layout.widgets) }

  func windowChanged(_ size: CGSize) {
    guard size != windowSize, size.width > 0 else { return }
    let before = arrangement
    windowSize = size
    let after = arrangement
    if before.columns != after.columns || before.pills.count != after.pills.count {
      state.note("layout", "\(Int(size.width))×\(Int(size.height)) → columns \(after.columns.left)+\(after.columns.right), \(after.frames.count) open, \(after.pills.count) pill(s), stage \(Int(after.stage.width))×\(Int(after.stage.height))")
    }
    if let p = openPill, !after.pills.contains(p) { openPill = nil }
  }

  func toggleCollapsed(_ w: WidgetSpec) {
    guard let i = layout.widgets.firstIndex(where: { $0.id == w.id }) else { return }
    layout.widgets[i].collapsed.toggle()
    state.note("hand", "\(layout.widgets[i].collapsed ? "folded" : "unfolded") \(w.kind.title)")
    if openPill == w.id { openPill = nil }
    persist()
  }

  func togglePill(_ id: String) {
    openPill = openPill == id ? nil : id
  }

  func add(_ kind: WidgetKind) {
    let id = "\(kind.rawValue)-\(Int(Date().timeIntervalSince1970))"
    layout.widgets.append(WidgetSpec(id: id, kind: kind))
    state.note("hand", "added \(kind.title)")
    persist()
  }

  func remove(_ w: WidgetSpec) {
    layout.widgets.removeAll { $0.id == w.id }
    if openPill == w.id { openPill = nil }
    state.note("hand", "removed \(w.kind.title)")
    persist()
  }

  func reset() {
    layout = BoardLayout.initial
    openPill = nil
    state.note("hand", "layout reset")
    persist()
  }

  private func persist() {
    let st = state
    store.save(layout) { url in Task { @MainActor in st.layoutSaved(url) } }
  }
}
