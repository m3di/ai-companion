import AppKit
import BodyKit
import SwiftUI

// The window: glass behind, the stage where the arrangement put it, the
// widgets in their columns, the pill bar under the stage, one open pill.

struct RootView: View {
  let state: AppState
  let board: Board
  let take: Take
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    GeometryReader { geo in
      let a = board.arrangement
      ZStack(alignment: .topLeading) {
        Glass().ignoresSafeArea()
        StageView(state: state, take: take)
          .frame(width: a.stage.width, height: a.stage.height)
          .offset(x: a.stage.minX, y: a.stage.minY)
        ForEach(board.layout.widgets) { w in
          if let f = a.frames[w.id] {
            WidgetHost(spec: w, frame: f, state: state, board: board)
          }
        }
        if let bar = a.pillBar {
          PillBar(bar: bar, pills: a.pills.compactMap { id in board.layout.widgets.first { $0.id == id } }, state: state, board: board)
        }
        if let open = board.openPill, let w = board.layout.widgets.first(where: { $0.id == open }), let i = a.pills.firstIndex(of: open) {
          PillPopover(spec: w, frame: pillPopover(for: i, in: a, window: board.window), state: state, board: board)
        }
      }
      .onAppear { board.windowChanged(geo.size) }
      .onChange(of: geo.size) { _, s in board.windowChanged(s) }
    }
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Menu {
          ForEach(WidgetKind.allCases, id: \.self) { k in
            Button { board.add(k) } label: { Label(k.title, systemImage: k.symbol) }
          }
          Divider()
          Button("Reset layout") { board.reset() }
        } label: { Label("Widgets", systemImage: "plus.square.on.square") }
        Button {
          openWindow(id: "graph")
          state.note("hand", "opened the graph window")
        } label: { Label("Graph", systemImage: "point.3.connected.trianglepath.dotted") }
          .help("The Atlas, in its own window")
      }
    }
  }
}

/// The window's material. `behindWindow` so the desktop shows through; the
/// Atlas inside a web view sits on this with a transparent page later.
struct Glass: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .underWindowBackground
    v.blendingMode = .behindWindow
    v.state = .active
    return v
  }
  func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

enum Palette {
  static let stage = Color(red: 0.55, green: 0.45, blue: 0.95)
  // Reflex's grades, kept: sure is plain text, unsure amber, guess red, moving grey.
  static let sure = Color.primary
  static let unsure = Color(red: 0.98, green: 0.66, blue: 0.18)
  static let guess = Color(red: 1.0, green: 0.33, blue: 0.36)
  static let volatile = Color.secondary.opacity(0.55)
  static func grade(_ g: Word.Grade) -> Color {
    switch g { case .sure: return sure; case .unsure: return unsure; case .guess: return guess; case .unscored: return volatile }
  }
  static let live = Color.green
  static let lost = Color.red
  static let here = Color.mint
  static let away = Color.gray
  static func kind(_ k: String) -> Color {
    switch k {
    case "entity-change", "write": return .orange
    case "probe": return .secondary.opacity(0.7)
    case "focus": return .teal
    case "call": return .blue
    case "friction": return .red
    case "turn", "tool": return .purple
    case "operator", "night", "run": return Palette.stage
    default: return .secondary
    }
  }
}
