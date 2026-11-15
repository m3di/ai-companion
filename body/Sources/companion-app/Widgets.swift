import BodyKit
import SwiftUI
import WebKit

// The widgets of part 1. Each is a RENDER of something the Atlas serves; the
// only one about the body itself is "This app", which is the observability
// the part is for.

struct WidgetContent: View {
  let spec: WidgetSpec
  let state: AppState
  /// Less space, less content: the arrangement decides, the widget obeys.
  let compact: Bool
  var body: some View {
    switch spec.kind {
    case .vitals: VitalsWidget(state: state, compact: compact)
    case .feed: FeedWidget(state: state, compact: compact)
    case .focus, .friction, .observations, .nights: LensWidget(state: state, name: spec.kind.lens!, compact: compact)
    case .appState: AppStateWidget(state: state, compact: compact)
    }
  }
}

// MARK: vitals

struct VitalsWidget: View {
  let state: AppState
  let compact: Bool
  var body: some View {
    ScrollView {
      if let v = state.vitals {
        VStack(alignment: .leading, spacing: 10) {
          if compact {
            // The four numbers that change what you do, one line each.
            Stat("entities", v.graph?.entities, note: "\(v.graph?.open ?? 0) open")
            Stat("lint errors", v.graph?.lintErrors, bad: (v.graph?.lintErrors ?? 0) > 0)
            Stat("inbox", v.memory?.pendingObservations, note: "\(v.memory?.proposals ?? 0) proposals")
            Stat("friction 24h", v.memory?.frictionLast24h)
            Stat("last dream", nil, note: v.night?.lastDream.map(shortTime).map { "\($0) · \(String(format: "%.1f", v.night?.hoursSinceDream ?? 0)) h ago" })
          } else {
          Section("Graph") {
            Stat("entities", v.graph?.entities); Stat("domains", v.graph?.domains); Stat("open", v.graph?.open)
            Stat("rot", v.graph?.rot, note: v.graph?.rotAt.map(shortTime)); Stat("lint errors", v.graph?.lintErrors, bad: (v.graph?.lintErrors ?? 0) > 0)
          }
          Section("Memory") {
            Stat("inbox", v.memory?.pendingObservations); Stat("proposals", v.memory?.proposals)
            Stat("friction open", v.memory?.openFriction); Stat("friction 24h", v.memory?.frictionLast24h)
            if let g = v.memory?.goalQuestions { Stat("goal questions", g.open, note: "\(g.asked ?? 0) asked") }
          }
          Section("Day") {
            Stat("messages 24h", v.day?.messages24h); Stat("focus open", v.day?.focusOpen)
            Stat("context chars", v.day?.contextChars); Stat("session since", nil, note: v.day?.conciergeSince.map(shortTime))
          }
          Section("Night") {
            Stat("dreams", v.night?.dreams)
            Stat("last", nil, note: v.night?.lastDream.map(shortTime).map { "\($0) · \(String(format: "%.1f", v.night?.hoursSinceDream ?? 0)) h ago" })
            Stat("settled", nil, note: v.night?.settled.map { "\($0.how ?? "?") @ \(shortTime($0.boundary ?? ""))" })
          }
          if let at = state.vitalsAt { Text("as of \(at.formatted(date: .omitted, time: .standard))").font(.caption2).foregroundStyle(.tertiary) }
          }
        }
        .padding(10)
      } else {
        Empty(text: state.fetchErrors > 0 ? "vitals unreachable — \(state.atlas.base.absoluteString)" : "fetching vitals…")
      }
    }
  }
}

private struct Section<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content
  init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.tertiary).padding(.bottom, 1)
      content
    }
  }
}

private struct Stat: View {
  let label: String
  let value: Int?
  let note: String?
  let bad: Bool
  init(_ label: String, _ value: Int?, note: String? = nil, bad: Bool = false) { self.label = label; self.value = value; self.note = note; self.bad = bad }
  var body: some View {
    HStack(spacing: 6) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Spacer(minLength: 4)
      if let n = note { Text(n).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1) }
      if let v = value { Text("\(v)").font(.callout.monospacedDigit().weight(.medium)).foregroundStyle(bad ? .red : .primary) }
    }
  }
}

// MARK: feed

struct FeedWidget: View {
  let state: AppState
  let compact: Bool
  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(state.pulses) { p in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(shortClock(p.at)).font(.caption2.monospaced()).foregroundStyle(.tertiary)
              if !compact { Text(p.kind).font(.caption2.monospaced()).foregroundStyle(Palette.kind(p.kind)).frame(width: 84, alignment: .leading) }
              Text(p.text).font(.caption).foregroundStyle(compact ? Palette.kind(p.kind) : .primary).lineLimit(compact ? 1 : 2)
            }
            .id(p.seq)
          }
        }
        .padding(8)
      }
      .onChange(of: state.lastSeq) { _, s in if let s { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(s, anchor: .bottom) } } }
      .overlay { if state.pulses.isEmpty { Empty(text: "waiting for the stream…") } }
    }
  }
}

// MARK: lens

struct LensWidget: View {
  let state: AppState
  let name: String
  let compact: Bool
  var body: some View {
    if let lens = state.lenses[name] {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: compact ? 3 : 6) {
          if !compact, let h = lens.hint { Text(h).font(.caption2).foregroundStyle(.tertiary).lineLimit(3) }
          ForEach(lens.rows) { r in
            VStack(alignment: .leading, spacing: 1) {
              Text(r.title).font(.caption.weight(.medium)).lineLimit(1)
              if !compact, let s = r.subtitle, !s.isEmpty { Text(s).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
            }
            .padding(.vertical, 2)
          }
          HStack {
            Text("\(lens.rows.count) row(s)")
            if let at = state.lensAt[name] { Text("· \(at.formatted(date: .omitted, time: .standard))") }
          }
          .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(8)
      }
    } else {
      Empty(text: state.fetchErrors > 0 ? "lens \(name) unreachable" : "fetching \(name)…")
    }
  }
}

// MARK: this app (observability)

struct AppStateWidget: View {
  let state: AppState
  let compact: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
        row("stream", state.connection.label + (reconnectNote))
        row("heartbeat", state.lastHeartbeat.map { "\(Int(Date().timeIntervalSince($0))) s ago" } ?? "none yet")
        row("pulses", "\(state.pulses.count) held · \(state.pulsesPerMinute)/min · seq \(state.lastSeq.map(String.init) ?? "–")")
        row("fetch errors", "\(state.fetchErrors)")
        row("presence", "\(state.presence.presence.rawValue) · idle \(state.presence.idleSeconds.map { String(format: "%.0f s", $0) } ?? "?")")
        row("layout", state.layoutURL?.lastPathComponent ?? "not saved yet" + (state.layoutSavedAt.map { " · \($0.formatted(date: .omitted, time: .standard))" } ?? ""))
        row("uptime", uptime)
      }
      .font(.caption)
      if !compact {
      Divider().opacity(0.4)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(state.log) { l in
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(l.at.formatted(date: .omitted, time: .standard)).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                Text(l.tag).font(.caption2.monospaced()).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
                Text(l.text).font(.caption2).lineLimit(2)
              }
              .id(l.id)
            }
          }
        }
        .onChange(of: state.log.count) { _, _ in if let last = state.log.last { proxy.scrollTo(last.id, anchor: .bottom) } }
      }
      }
    }
    .padding(8)
    .task {
      // The relative times ("12 s ago") tick once a second while the widget is open.
      while !Task.isCancelled { try? await Task.sleep(for: .seconds(1)); tick += 1 }
    }
  }
  @State private var tick = 0

  private var reconnectNote: String { state.reconnects > 0 ? " · \(state.reconnects) reconnect(s)" : "" }
  private var uptime: String {
    let s = Int(Date().timeIntervalSince(state.started)) + tick * 0
    return s < 60 ? "\(s) s" : s < 3600 ? "\(s / 60) min" : String(format: "%.1f h", Double(s) / 3600)
  }
  @ViewBuilder private func row(_ k: String, _ v: String) -> some View {
    GridRow { Text(k).foregroundStyle(.secondary); Text(v).monospacedDigit().lineLimit(1) }
  }
}

// MARK: the graph window — the Atlas itself, in a web view

struct GraphWindow: View {
  let state: AppState
  var body: some View {
    AtlasWeb(url: state.atlas.base)
      .background(Glass())
      .overlay(alignment: .topTrailing) {
        Text("Atlas · \(state.atlas.base.absoluteString)").font(.caption2.monospaced()).foregroundStyle(.tertiary).padding(6)
      }
  }
}

/// The web Atlas, hosted. Transparent so the glass shows through once the
/// page's own background is made transparent (part 5's native pass).
struct AtlasWeb: NSViewRepresentable {
  let url: URL
  func makeNSView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    let v = WKWebView(frame: .zero, configuration: cfg)
    v.setValue(false, forKey: "drawsBackground")
    v.load(URLRequest(url: url))
    return v
  }
  func updateNSView(_ nsView: WKWebView, context: Context) {}
}

// MARK: bits

struct Empty: View {
  let text: String
  var body: some View {
    Text(text).font(.caption).foregroundStyle(.tertiary).frame(maxWidth: .infinity, maxHeight: .infinity).padding(10)
  }
}

/// "2026-10-05 08:07:56" → "08:07" ; ISO "…T09:16:33.947Z" → "09:16".
func shortTime(_ s: String) -> String {
  if let t = s.firstIndex(of: "T") ?? s.firstIndex(of: " ") {
    let rest = s[s.index(after: t)...]
    return String(rest.prefix(5))
  }
  return s
}

func shortClock(_ iso: String) -> String {
  // The pulse's `at` is UTC ISO; show it in local time.
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
    return d.formatted(date: .omitted, time: .standard)
  }
  return shortTime(iso)
}
