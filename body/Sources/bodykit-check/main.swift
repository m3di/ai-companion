import BodyKit
import BodyKit
import Foundation

// The gate for BodyKit, as an executable: this Mac has the Command Line Tools
// and no Xcode, so neither XCTest nor swift-testing is available to `swift
// test`. Same shape as reflex's scripts/regress.sh — a check prints before the
// next runs, and the process exits non-zero on the first failure count > 0.

nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var checks = 0
func check(_ cond: Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
  checks += 1
  if !cond {
    failures += 1
    print("  FAIL  \(file):\(line) \(message)")
  }
}

import Foundation

struct ArrangeTests {
  let four = BoardLayout.initial.widgets

  func theStageIsTheWindowWhenThereAreNoWidgets() throws {
    let a = arrange(window: CGRect(x: 0, y: 0, width: 1300, height: 840), widgets: [])
    check(a.stage == CGRect(x: 12, y: 12, width: 1276, height: 816), "stage fills: \(a.stage)")
    check(a.pillBar == nil && a.frames.isEmpty)
  }

  func wideWindowGetsOneColumnEachSideAndTheStageTakesTheRest() throws {
    let win = CGRect(x: 0, y: 0, width: 1300, height: 840)
    let a = arrange(window: win, widgets: four)
    check(a.columns == (1, 1), "columns: \(a.columns)")
    check(a.frames.count == 4 && a.pills.isEmpty, "all four open")
    let l = a.frames["vitals"]!, r = a.frames["focus"]!
    check(l.minX == 12 && r.maxX == 1288, "columns hug the edges: \(l) \(r)")
    check(abs(a.stage.minX - (l.maxX + 12)) < 0.01 && abs(a.stage.maxX - (r.minX - 12)) < 0.01, "stage fills between: \(a.stage)")
    check(a.stage.minY == 12 && a.stage.height == 816, "full height: \(a.stage)")
    check(l.width >= 240 && l.width <= 420 && a.stage.width >= 520)
    check(a.frames["feed"]!.minY > l.maxY && a.frames["feed"]!.maxY == 828, "stacked to the bottom")
  }

  func columnsWidenAndTheStageGrowsWithTheWindow() throws {
    let a = arrange(window: CGRect(x: 0, y: 0, width: 2400, height: 1200), widgets: four)
    check(a.columns == (1, 1), "still one column each side with four widgets: \(a.columns)")
    check(a.frames["vitals"]!.width == 420, "columns at their max: \(a.frames["vitals"]!)")
    check(a.stage.width > 1300, "the stage took the rest: \(a.stage)")
  }

  func manyWidgetsOnAShortWindowEarnASecondColumn() throws {
    var many = four
    many += [WidgetSpec(id: "friction", kind: .friction), WidgetSpec(id: "nights", kind: .nights), WidgetSpec(id: "inbox", kind: .observations), WidgetSpec(id: "x", kind: .vitals)]
    let a = arrange(window: CGRect(x: 0, y: 0, width: 2400, height: 500), widgets: many)
    check(a.columns == (2, 2), "two columns each side: \(a.columns)")
    check(a.frames.count == 8 && a.pills.isEmpty, "all eight open: \(a.pills)")
    for f in a.frames.values { check(f.height >= 170, "squeezed: \(f)") }
  }

  func aOneSidedSetLeavesTheOtherSideToTheStage() throws {
    let a = arrange(window: CGRect(x: 0, y: 0, width: 1300, height: 840), widgets: [four[0]])
    check(a.columns == (1, 0), "left only: \(a.columns)")
    check(a.stage.maxX == 1288, "stage reaches the right edge: \(a.stage)")
    check(a.frames["vitals"]!.height == 816, "one widget, full height")
  }

  func narrowWindowKeepsTheLeftColumnThenFoldsEverything() throws {
    // 900 wide: one column still fits beside a stage of 624 — the LEFT one stays.
    let a = arrange(window: CGRect(x: 0, y: 0, width: 900, height: 700), widgets: four)
    check(a.columns == (1, 0), "left column kept: \(a.columns)")
    check(a.pills == ["focus", "appState"], "the right side folded, in order: \(a.pills)")
    check(a.stage.maxX == 888 && a.stage.maxY + 12 == a.pillBar!.minY, "stage to the right edge, above the bar: \(a.stage)")
    // 760 wide: no column leaves the stage its minimum — every widget is a pill.
    let b = arrange(window: CGRect(x: 0, y: 0, width: 760, height: 700), widgets: four)
    check(b.columns == (0, 0) && b.frames.isEmpty, "no columns: \(b.columns)")
    check(b.pills == ["vitals", "focus", "feed", "appState"] && b.pillBar != nil, "four pills in order: \(b.pills)")
    check(b.stage.width == 736, "stage is the window: \(b.stage)")
  }

  func overflowAndHandFoldsBecomePills() throws {
    var many = four
    many += [WidgetSpec(id: "friction", kind: .friction), WidgetSpec(id: "nights", kind: .nights)]
    let a = arrange(window: CGRect(x: 0, y: 0, width: 1300, height: 420), widgets: many)
    check(a.frames.count + a.pills.count == 6)
    check(!a.pills.isEmpty && a.pillBar != nil, "overflow became pills: \(a.pills)")
    for f in a.frames.values { check(f.height >= 170, "squeezed: \(f)") }
    var folded = four; folded[0].collapsed = true
    let b = arrange(window: CGRect(x: 0, y: 0, width: 1300, height: 840), widgets: folded)
    check(b.pills == ["vitals"] && b.frames.count == 3)
  }

  func popoverStaysInsideTheWindow() throws {
    let win = CGRect(x: 0, y: 0, width: 760, height: 700)
    let a = arrange(window: win, widgets: four)
    for i in 0..<4 {
      let p = pillPopover(for: i, in: a, window: win)
      check(win.insetBy(dx: 4, dy: 4).contains(p), "popover \(i) off screen: \(p)")
    }
  }
}

struct LayoutTests {
  func layoutRoundTripsThroughTheStore() throws {
    let url = FileManager.default.temporaryDirectory.appending(path: "body-test-\(UUID().uuidString)/layout.json")
    let store = LayoutStore(url: url)
    check(store.load() == nil)
    var l = BoardLayout.initial
    l.widgets[0].collapsed = true
    try store.saveNow(l)
    check(store.load() == l)
    // A version-1 file (frames) is ignored, not crashed on.
    try Data(#"{"version":1,"window":[1,1],"widgets":[{"id":"a","kind":"vitals","frame":[[0,0],[1,1]],"collapsed":false,"z":1}]}"#.utf8).write(to: url)
    check(store.load() == nil, "an old layout file reads as none")
  }
}

struct TakeStoreTests {
  func aTakeRoundTripsAndTheLatestIsFound() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "body-takes-\(UUID().uuidString)")
    let store = TakeStore(root: root)
    check(store.latestId() == nil)
    let a = SavedTake(id: "1700000000", startedAt: Date(timeIntervalSince1970: 1_700_000_000), stoppedAt: nil, lines: [[Word(text: " hello", confidence: 0.9)]], polished: "", passes: 0, deep: false)
    let b = SavedTake(id: "1700000100", startedAt: Date(timeIntervalSince1970: 1_700_000_100), stoppedAt: Date(timeIntervalSince1970: 1_700_000_160), lines: [[Word(text: " the", confidence: 0.8), Word(text: " airport.", confidence: nil)]], polished: "The airport.", passes: 2, deep: true)
    try store.saveNow(a); try store.saveNow(b)
    check(store.latestId() == "1700000100", "latest by name: \(store.latestId() ?? "nil")")
    let back = store.load("1700000100")
    check(back?.lines == b.lines && back?.polished == "The airport." && back?.deep == true && back?.passes == 2, "round trip: \(String(describing: back))")
    check(store.audioURL("1700000100").path.hasSuffix("1700000100/audio.caf"))
    store.delete("1700000100")
    check(store.latestId() == "1700000000", "delete removes the folder")
  }
}

struct StreamTests {
  func sseParserSplitsDataAndHeartbeats() throws {
    var p = SSEParser()
    check(p.feed(line: ": beat") == .heartbeat)
    check(p.feed(line: "data: {\"a\":1}") == nil)
    check(p.feed(line: "") == .data("{\"a\":1}"))
    check(p.feed(line: "") == nil, "a blank line with nothing pending is not an event")
    check(p.feed(line: "data:x") == nil)
    check(p.feed(line: "data: y") == nil)
    check(p.feed(line: "") == .data("x\ny"))
  }

  func pulseDecodesTheAtlasShape() throws {
    let json = #"{"seq":5056,"at":"2026-10-05T09:16:33.947Z","kind":"probe","text":"probing x","refs":["a/b"],"domains":["a"]}"#
    let p = try JSONDecoder().decode(Pulse.self, from: Data(json.utf8))
    check(p.seq == 5056 && p.kind == "probe" && p.refs == ["a/b"])
  }

  func vitalsDecodesTheLiveShapeAndTolerateMissingFields() throws {
    let json = #"{"mode":"live","graph":{"entities":189,"domains":12,"open":36,"lintErrors":0,"rot":213,"rotAt":"2026-10-05 00:30:42"},"memory":{"pendingObservations":0,"oldestObservation":null,"proposals":0,"openFriction":85,"frictionLast24h":3,"goalQuestions":{"open":7,"asked":4,"parked":0}},"day":{"messages24h":28,"focusOpen":70,"conciergeSince":"2026-10-05 08:15:35","contextChars":10061},"night":{"dreams":121,"lastDream":"2026-10-05 08:07:56","hoursSinceDream":1.8,"settled":{"boundary":"2026-10-05 00:30:00","how":"dreamt"}},"runs":{"total":51},"pulseId":101115}"#
    let v = try JSONDecoder().decode(Vitals.self, from: Data(json.utf8))
    check(v.graph?.entities == 189 && v.night?.settled?.how == "dreamt")
    let bare = try JSONDecoder().decode(Vitals.self, from: Data(#"{"mode":"live"}"#.utf8))
    check(bare.graph == nil && bare.mode == "live")
  }
}

struct PresenceTests {
  func idleClassifies() throws {
    check(PresenceProbe.classify(idleSeconds: 3) == .here)
    check(PresenceProbe.classify(idleSeconds: 299) == .here)
    check(PresenceProbe.classify(idleSeconds: 300) == .away)
    check(PresenceProbe.classify(idleSeconds: nil) == .away)
  }
}

@main struct Main {
  static func main() {
    run("ArrangeTests.theStageIsTheWindowWhenThereAreNoWidgets") { try ArrangeTests().theStageIsTheWindowWhenThereAreNoWidgets() }
    run("ArrangeTests.wideWindowGetsOneColumnEachSideAndTheStageTakesTheRest") { try ArrangeTests().wideWindowGetsOneColumnEachSideAndTheStageTakesTheRest() }
    run("ArrangeTests.columnsWidenAndTheStageGrowsWithTheWindow") { try ArrangeTests().columnsWidenAndTheStageGrowsWithTheWindow() }
    run("ArrangeTests.manyWidgetsOnAShortWindowEarnASecondColumn") { try ArrangeTests().manyWidgetsOnAShortWindowEarnASecondColumn() }
    run("ArrangeTests.aOneSidedSetLeavesTheOtherSideToTheStage") { try ArrangeTests().aOneSidedSetLeavesTheOtherSideToTheStage() }
    run("ArrangeTests.narrowWindowKeepsTheLeftColumnThenFoldsEverything") { try ArrangeTests().narrowWindowKeepsTheLeftColumnThenFoldsEverything() }
    run("ArrangeTests.overflowAndHandFoldsBecomePills") { try ArrangeTests().overflowAndHandFoldsBecomePills() }
    run("ArrangeTests.popoverStaysInsideTheWindow") { try ArrangeTests().popoverStaysInsideTheWindow() }
    run("LayoutTests.layoutRoundTripsThroughTheStore") { try LayoutTests().layoutRoundTripsThroughTheStore() }
    run("TakeStoreTests.aTakeRoundTripsAndTheLatestIsFound") { try TakeStoreTests().aTakeRoundTripsAndTheLatestIsFound() }
    run("StreamTests.sseParserSplitsDataAndHeartbeats") { try StreamTests().sseParserSplitsDataAndHeartbeats() }
    run("StreamTests.pulseDecodesTheAtlasShape") { try StreamTests().pulseDecodesTheAtlasShape() }
    run("StreamTests.vitalsDecodesTheLiveShapeAndTolerateMissingFields") { try StreamTests().vitalsDecodesTheLiveShapeAndTolerateMissingFields() }
    run("PresenceTests.idleClassifies") { try PresenceTests().idleClassifies() }
    print(failures == 0 ? "  ok    \(checks) check(s)" : "  FAILED \(failures) of \(checks) check(s)")
    exit(failures == 0 ? 0 : 1)
  }
  static func run(_ name: String, _ body: () throws -> Void) {
    do { try body(); print("  ok    \(name)") } catch { failures += 1; print("  FAIL  \(name) threw \(error)") }
  }
}
