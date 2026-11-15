import CoreGraphics
import Foundation

// THE ARRANGEMENT — one self-organising grid. Mehdi, after the second run:
// "the app is a big responsive self-organising grid; everyone sits inside it
// and claims its size, so the grid takes the final optimal shape." The stage
// is a member like the widgets, not a fixed shape they snap around.
//
// Every member CLAIMS a width range; the grid grants them. Widgets claim
// 240–420 and prefer 320; the stage claims at least 520 and takes everything
// left. Columns beside the stage appear only when stacking would squeeze a
// widget below its minimum height, and only while the stage keeps its own
// minimum. What cannot be granted becomes a pill in a bar under the stage;
// with no widgets at all, the stage is the window. Full height, always.
// Pure, and checked.

public struct Arrangement: Equatable, Sendable {
  public var stage: CGRect
  /// Expanded widgets, by id.
  public var frames: [String: CGRect]
  /// Widgets shown as pills, in order, with the pill bar they sit in.
  public var pills: [String]
  public var pillBar: CGRect?
  public var columns: (left: Int, right: Int)
  /// Below this height or width a widget shows its compact content.
  public static let compactHeight: CGFloat = 260
  public static let compactWidth: CGFloat = 230

  public static func == (a: Arrangement, b: Arrangement) -> Bool {
    a.stage == b.stage && a.frames == b.frames && a.pills == b.pills && a.pillBar == b.pillBar && a.columns == b.columns
  }
}

public struct ArrangeRules: Sendable {
  public var pad: CGFloat = 12
  public var minWidth: CGFloat = 240
  public var preferredWidth: CGFloat = 320
  public var maxWidth: CGFloat = 420
  public var minHeight: CGFloat = 170
  public var minStage: CGFloat = 520
  public var preferredStage: CGFloat = 900
  public var pillBarHeight: CGFloat = 44
  public var maxColumns = 2
  public init() {}
}

public func arrange(window: CGRect, widgets: [WidgetSpec], rules r: ArrangeRules = ArrangeRules()) -> Arrangement {
  let pad = r.pad
  let inner = window.insetBy(dx: pad, dy: pad)
  var pills: [String] = widgets.filter(\.collapsed).map(\.id)
  let shown = widgets.filter { !$0.collapsed }

  // Split left/right in order; the sides claim columns.
  var sides: [[WidgetSpec]] = [[], []]
  for (i, w) in shown.enumerated() { sides[i % 2].append(w) }

  // How many fit stacked in one full-height column (the bar, if it comes, is
  // accounted for by a second pass below).
  func rowsFit(barShown: Bool) -> Int {
    let h = inner.height - (barShown ? r.pillBarHeight + pad : 0)
    return max(1, Int(((h + pad) / (r.minHeight + pad)).rounded(.down)))
  }

  // Columns each side WANTS: enough that nothing is squeezed, capped.
  func wanted(_ n: Int, rows: Int) -> Int { n == 0 ? 0 : min(r.maxColumns, Int((Double(n) / Double(rows)).rounded(.up))) }

  // Grant: shrink the ask until the stage keeps its minimum — first the column
  // width toward the minimum, then a column, then (at the caller) the side.
  func grant(leftCols: Int, rightCols: Int) -> (colW: CGFloat, stageW: CGFloat)? {
    let total = CGFloat(leftCols + rightCols)
    if total == 0 { return (0, inner.width) }
    // Columns grow toward their maximum once the stage has its preferred width.
    let colW = min(r.maxWidth, max(r.minWidth, (inner.width - r.preferredStage - pad * total) / total))
    let stageW = inner.width - total * (colW + pad)
    return stageW >= r.minStage ? (colW, stageW) : nil
  }

  var barShown = !pills.isEmpty
  var rows = rowsFit(barShown: barShown)
  var cols = (wanted(sides[0].count, rows: rows), wanted(sides[1].count, rows: rows))
  var granted = grant(leftCols: cols.0, rightCols: cols.1)
  // Too wide an ask: drop a column from the right first (the left holds the
  // first-added widgets), then from the left, until the stage has its minimum.
  while granted == nil, cols.0 + cols.1 > 0 {
    if cols.1 >= cols.0, cols.1 > 0 { cols.1 -= 1 } else { cols.0 -= 1 }
    granted = grant(leftCols: cols.0, rightCols: cols.1)
  }
  let (colW, _) = granted ?? (0, inner.width)

  // Place: per side, what the granted columns can hold stays; the rest are pills.
  var frames: [String: CGRect] = [:]
  var placedSides: [[WidgetSpec]] = [[], []]
  for s in 0..<2 {
    let c = s == 0 ? cols.0 : cols.1
    let keep = c == 0 ? 0 : min(sides[s].count, c * rows)
    placedSides[s] = Array(sides[s][..<keep])
    pills.append(contentsOf: sides[s][keep...].map(\.id))
  }
  // A bar that appeared lowers the rows; re-check once (it converges: the bar
  // only ever appears, never disappears, in this pass).
  if !pills.isEmpty, !barShown {
    barShown = true
    rows = rowsFit(barShown: true)
    for s in 0..<2 {
      let c = s == 0 ? cols.0 : cols.1
      let keep = c == 0 ? 0 : min(placedSides[s].count, c * rows)
      pills.append(contentsOf: placedSides[s][keep...].map(\.id))
      placedSides[s] = Array(placedSides[s][..<keep])
    }
  }
  let colH = inner.height - (barShown ? r.pillBarHeight + pad : 0)
  for s in 0..<2 {
    let c = s == 0 ? cols.0 : cols.1
    guard c > 0, !placedSides[s].isEmpty else { continue }
    var columns: [[WidgetSpec]] = Array(repeating: [], count: c)
    for (i, w) in placedSides[s].enumerated() { columns[i % c].append(w) }
    for (ci, column) in columns.enumerated() where !column.isEmpty {
      let n = CGFloat(column.count)
      let h = (colH - pad * (n - 1)) / n
      let x = s == 0 ? inner.minX + CGFloat(ci) * (colW + pad) : inner.maxX - colW - CGFloat(ci) * (colW + pad)
      for (ri, w) in column.enumerated() {
        frames[w.id] = CGRect(x: x, y: inner.minY + CGFloat(ri) * (h + pad), width: colW, height: h)
      }
    }
  }

  // The stage: everything between the granted columns, full height above the bar.
  let leftW = cols.0 > 0 ? CGFloat(cols.0) * (colW + pad) : 0
  let rightW = cols.1 > 0 ? CGFloat(cols.1) * (colW + pad) : 0
  let stage = CGRect(x: inner.minX + leftW, y: inner.minY, width: inner.width - leftW - rightW, height: colH)
  let bar = barShown ? CGRect(x: stage.minX, y: stage.maxY + pad, width: stage.width, height: r.pillBarHeight) : nil
  // Pills keep the widgets' order, whatever side they fell from.
  let order = Dictionary(uniqueKeysWithValues: widgets.enumerated().map { ($1.id, $0) })
  pills.sort { (order[$0] ?? 0) < (order[$1] ?? 0) }
  return Arrangement(stage: stage, frames: frames, pills: pills, pillBar: bar, columns: (cols.0, cols.1))
}

/// Where an opened pill floats: over the stage's foot, above the bar,
/// anchored to the pill's x when known. One at a time; opening another closes it.
public func pillPopover(for index: Int, in a: Arrangement, window: CGRect, size: CGSize = CGSize(width: 360, height: 400)) -> CGRect {
  guard let bar = a.pillBar else { return CGRect(origin: .zero, size: size) }
  let w = min(size.width, window.width - 24)
  let h = min(size.height, window.height - 24)
  let x = min(max(window.minX + 12, bar.minX + CGFloat(index) * 110), window.maxX - 12 - w)
  let y = max(window.minY + 12, bar.minY - 8 - h)
  return CGRect(x: x, y: y, width: w, height: h)
}
