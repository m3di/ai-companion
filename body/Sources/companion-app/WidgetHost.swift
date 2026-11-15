import BodyKit
import SwiftUI

// One widget on the board: its chrome (title, fold, remove) and its content,
// at the frame the arrangement gave it. Frozen: no gestures.

struct WidgetHost: View {
  let spec: WidgetSpec
  let frame: CGRect
  let state: AppState
  let board: Board
  @State private var hovering = false

  private var compact: Bool { frame.height < Arrangement.compactHeight || frame.width < Arrangement.compactWidth }

  var body: some View {
    VStack(spacing: 0) {
      titleBar
      Divider().opacity(0.4)
      WidgetContent(spec: spec, state: state, compact: compact)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }
    .frame(width: frame.width, height: frame.height)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.background.opacity(0.62)))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(hovering ? 0.14 : 0.07)))
    .shadow(color: .black.opacity(0.14), radius: 14, y: 6)
    .onHover { hovering = $0 }
    .offset(x: frame.minX, y: frame.minY)
  }

  private var titleBar: some View {
    HStack(spacing: 8) {
      Image(systemName: spec.kind.symbol).font(.caption).foregroundStyle(.secondary)
      Text(spec.kind.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      if compact { Text("compact").font(.caption2).foregroundStyle(.tertiary) }
      Spacer()
      if hovering {
        Button { board.toggleCollapsed(spec) } label: { Image(systemName: "minus") }.help("Fold into a pill")
        Button { board.remove(spec) } label: { Image(systemName: "xmark") }.help("Remove (add it back from Widgets)")
      }
    }
    .font(.caption)
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10).padding(.vertical, 7)
  }
}

/// The bar of pills under the stage: widgets folded by hand, and widgets the
/// window had no room for.
struct PillBar: View {
  let bar: CGRect
  let pills: [WidgetSpec]
  let state: AppState
  let board: Board

  var body: some View {
    HStack(spacing: 8) {
      ForEach(pills) { w in pill(w) }
      Spacer()
    }
    .frame(width: bar.width, height: bar.height)
    .offset(x: bar.minX, y: bar.minY)
  }

  private func pill(_ w: WidgetSpec) -> some View {
    let open = board.openPill == w.id
    let fill: Color = open ? Palette.stage.opacity(0.25) : Color.primary.opacity(0.06)
    return Button { board.togglePill(w.id) } label: {
      HStack(spacing: 6) {
        Image(systemName: w.kind.symbol)
        Text(w.kind.title).font(.caption)
        if w.kind == .feed, state.pulsesPerMinute > 0 {
          Text("\(state.pulsesPerMinute)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 7)
      .background(Capsule().fill(fill))
      .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
    }
    .buttonStyle(.plain)
    .help(w.collapsed ? "Folded by you — open, or unfold from its title" : "No room beside the stage at this size — open it here")
  }
}

/// A pill opened: one floating widget over the stage's foot, closed by its
/// own button or by opening another.
struct PillPopover: View {
  let spec: WidgetSpec
  let frame: CGRect
  let state: AppState
  let board: Board

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: spec.kind.symbol).font(.caption).foregroundStyle(.secondary)
        Text(spec.kind.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        if spec.collapsed {
          Button { board.toggleCollapsed(spec) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.help("Unfold back beside the stage")
        }
        Button { board.togglePill(spec.id) } label: { Image(systemName: "xmark") }
      }
      .font(.caption).buttonStyle(.plain).foregroundStyle(.secondary)
      .padding(.horizontal, 10).padding(.vertical, 7)
      Divider().opacity(0.4)
      WidgetContent(spec: spec, state: state, compact: false)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }
    .frame(width: frame.width, height: frame.height)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.background.opacity(0.92)))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.stage.opacity(0.3)))
    .shadow(color: .black.opacity(0.25), radius: 22, y: 10)
    .offset(x: frame.minX, y: frame.minY)
  }
}
