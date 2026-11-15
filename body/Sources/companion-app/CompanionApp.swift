import AppKit
import BodyKit
import SwiftUI

// Companion — the body (round 12, part 1): a native window with the STAGE in
// the middle and WIDGETS snapped around it, every widget a live render of the
// bot's Atlas. Part 1 is the shell and the observability of the app's own
// state; the microphone (part 2), the prompt (part 3) and the bot's replies
// (part 4) land on this frame.
//
//   ./companion                                 build Companion.app and open it
//   companion-app --atlas http://host:port      another Atlas
//   companion-app --layout /tmp/x.json          a scratch layout and take store (tests never touch his)
//   companion-app --snapshot a.png [--size WxH] [--appearance dark|light]   capture and quit
//   companion-app --file talk.aiff [--snapshot a.png]   the ear over a file: no microphone, nothing played

let arguments = CommandLine.arguments
func option(_ name: String) -> String? {
  guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
  return arguments[i + 1]
}

/// `--stream-test [seconds]`: no window; print what /api/stream delivers, then
/// exit 0 if at least one data event arrived. The one check the gate cannot
/// make without a running bot.
/// `--polish-test`: no window, no microphone; the on-device polisher over the
/// Lisbon words, two passes, the second carrying a spoken correction.
/// Prints each pass with its time. Exits 0 when the correction took.
func polishTestIfAsked() {
  guard arguments.contains("--polish-test") else { return }
  let w: (String, Double) -> Word = { Word(text: " " + $0, confidence: $1) }
  let first: [Word] = [w("the", 0.78), w("11", 0.95), w("o'clock", 0.87), w("show", 0.93), w("at", 0.93), w("Riversyde", 0.65), w("Forum,", 0.76), w("then", 0.66), w("the", 0.99), w("airport.", 0.85), w("Skylar", 0.27), w("leaves", 0.99), w("at", 0.99), w("1825.", 0.96)]
  let more: [Word] = ["So", "you", "know", "I", "think", "we", "should", "we", "should", "remove", "the", "live", "text,", "you", "know,", "only", "the", "waveform", "is", "enough.", "No", "wait,", "you", "understood", "the", "airline", "wrongly,", "I", "said"].map { w($0, 0.9) } + [w("Skylark.", 0.6)]
  let sem = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var ok = false
  Task.detached {
    let p = OnDevicePolisher()
    print("model: \(OnDevicePolisher.availability)")
    let clock = ContinuousClock()
    var t = clock.now
    await p.warm()
    print(String(format: "warm: %.2f s", Double((clock.now - t).components.seconds) + Double((clock.now - t).components.attoseconds) / 1e18))
    do {
      t = clock.now
      let one = try await p.polish(raw: first, previous: "")
      let d1 = clock.now - t
      print(String(format: "pass 1 (%.2f s): %@", Double(d1.components.seconds) + Double(d1.components.attoseconds) / 1e18, one as NSString))
      t = clock.now
      let two = try await p.polish(raw: first + more, previous: one)
      let d2 = clock.now - t
      print(String(format: "pass 2 (%.2f s): %@", Double(d2.components.seconds) + Double(d2.components.attoseconds) / 1e18, two as NSString))
      // What the on-device model is held to: it keeps everything and reads fast.
      // The correction and the fillers are the deep pass's job (measured: it
      // does neither — see Polisher.swift).
      ok = two.contains("waveform") && two.contains("airport")
      print(ok ? "ok: fast pass kept the content" : "FAIL: the fast pass lost content")
      print(two.contains("Skylark") && !two.lowercased().contains("wrongly") ? "and the correction took" : "(correction not applied on device — the deep pass does that)")
    } catch { print("FAILED: \(error)") }
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 120)
  exit(ok ? 0 : 1)
}

func streamTestIfAsked() {
  guard arguments.contains("--stream-test") else { return }
  let secs = Double(option("--stream-test") ?? "") ?? 6
  let base = option("--atlas").flatMap(URL.init(string:)) ?? AtlasClient.defaultBase
  let client = AtlasClient(base: base)
  // Detached: top-level code is main-actor isolated, and the semaphore below
  // blocks the main thread — an inherited Task would never run (it did not).
  let sem = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var data = 0, beats = 0
  let task = Task.detached {
    do {
      for try await ev in client.stream() {
        switch ev {
        case .heartbeat: beats += 1; print("beat")
        case let .data(json): data += 1; print("data \(json.prefix(100))")
        }
      }
      print("stream ended")
    } catch { print("stream error: \(error)") }
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + secs)
  task.cancel()
  print("\(data) data event(s), \(beats) heartbeat(s) in \(secs) s")
  exit(data > 0 ? 0 : 1)
}
@main struct CompanionApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var state: AppState
  @State private var board: Board
  @State private var take: Take

  init() {
    streamTestIfAsked()
    polishTestIfAsked()
    let base = option("--atlas").flatMap(URL.init(string:))
      ?? ProcessInfo.processInfo.environment["COMPANION_ATLAS"].flatMap(URL.init(string:))
      ?? AtlasClient.defaultBase
    let st = AppState(atlas: AtlasClient(base: base))
    let store = LayoutStore(url: option("--layout").map { URL(fileURLWithPath: $0) } ?? LayoutStore.defaultURL)
    _state = State(initialValue: st)
    _board = State(initialValue: Board(store: store, state: st))
    // A test run (--layout, --file, --snapshot) never touches his takes.
    let scratch = option("--layout") != nil || option("--file") != nil || option("--snapshot") != nil
    let takes = scratch ? TakeStore(root: FileManager.default.temporaryDirectory.appending(path: "companion-test-takes-\(ProcessInfo.processInfo.processIdentifier)")) : TakeStore()
    _take = State(initialValue: Take(state: st, store: takes))
  }

  var body: some Scene {
    Window("Companion", id: "main") {
      RootView(state: state, board: board, take: take)
        .frame(minWidth: 980, minHeight: 640)
        .onAppear {
          state.run()
          if option("--snapshot") != nil { snapshotIfAsked() }
          if let f = option("--file") { fileTest(URL(fileURLWithPath: f)) }
        }
    }
    .windowStyle(.hiddenTitleBar)
    .windowToolbarStyle(.unifiedCompact)

    // The graph is the Atlas itself, in a window of its own (Mehdi, after the
    // first run: "better a separate window than a widget inside this one").
    Window("Graph", id: "graph") {
      GraphWindow(state: state).frame(minWidth: 720, minHeight: 520)
    }
    .defaultSize(width: 1100, height: 760)
  }

  /// `--file x.aiff`: the ear over a file — no microphone, nothing played —
  /// printing every word with its confidence, then the take as the stage
  /// holds it; exits 0 when at least one word was heard. The gate for part 2.
  @MainActor private func fileTest(_ url: URL) {
    let t = take
    t.ear.onEvent = { [weak t] e in
      t?.handleForTest(e)
      switch e {
      case let .result(words, isFinal):
        print((isFinal ? "FINAL " : "vol   ") + words.map { "\($0.text.trimmingCharacters(in: .whitespaces))(\($0.confidence.map { String(format: "%.2f", $0) } ?? "-"))" }.joined(separator: " "))
      case .finished:
        print("--- \(t?.wordCount ?? 0) word(s), \(t?.lines.count ?? 0) sentence(s): \(t?.text ?? "")")
        if option("--snapshot") == nil { exit((t?.wordCount ?? 0) > 0 ? 0 : 1) }
      case let .failed(s):
        print("FAILED \(s)"); exit(1)
      default: break
      }
    }
    t.phase = .preparing("file")
    t.startedAt = Date()
    Task { await t.ear.start(file: url) }
  }

  @MainActor private func snapshotIfAsked() {
    Task {
      guard let path = option("--snapshot") else { return }
      guard let window = NSApp.windows.first(where: { $0.isVisible }) else { exit(1) }
      if let size = option("--size")?.split(separator: "x").compactMap({ Double($0) }), size.count == 2 {
        window.setContentSize(NSSize(width: size[0], height: size[1]))
      }
      try? await Task.sleep(for: .milliseconds(2500))   // first fetches land, layout settles
      let capture = Process()
      capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
      capture.arguments = ["-x", "-o", "-l\(window.windowNumber)", path]
      try? capture.run()
      capture.waitUntilExit()
      if !FileManager.default.fileExists(atPath: path) {
        // No Screen Recording for the terminal: render the tree itself (no glass, no web view).
        let renderer = ImageRenderer(content: RootView(state: state, board: board, take: take).frame(width: 1240, height: 820)
          .environment(\.colorScheme, NSApp.effectiveAppearance.name == .darkAqua ? .dark : .light))
        renderer.scale = 2
        if let image = renderer.cgImage { try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path)) }
      }
      exit(0)
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var parentWatch: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate()
    // Spawned by the bot (src/body.ts): one lifetime. The bot kills us on its
    // shutdown; if it dies WITHOUT one, its pid disappears and we quit —
    // kill(pid, 0) is a probe, not a signal.
    if let pid = ProcessInfo.processInfo.environment["COMPANION_PARENT_PID"].flatMap(Int32.init) {
      parentWatch = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
        if kill(pid, 0) != 0 {
          FileHandle.standardError.write(Data("companion: the bot (pid \(pid)) is gone — quitting with it\n".utf8))
          exit(0)
        }
      }
    }
    if let appearance = option("--appearance") { NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua) }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
