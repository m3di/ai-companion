import CoreGraphics
import Foundation

// Presence, binary (round 12): HERE when a hand has touched this Mac recently,
// AWAY otherwise. Measured, not inferred — the seconds since the last
// keyboard/mouse event, which needs no permission. In part 1 it is only
// SHOWN; the router that acts on it is a later step, and it never enters the
// bot's prefix (I12).

public enum Presence: String, Sendable {
  case here, away
}

public struct PresenceSample: Equatable, Sendable {
  public let presence: Presence
  /// Seconds since the last HID event, or nil when the system did not say.
  public let idleSeconds: Double?
  public let at: Date
}

public enum PresenceProbe {
  /// `here` while the hand was on the machine within `window` seconds.
  public static let window: Double = 300

  public static func sample(now: Date = Date()) -> PresenceSample {
    let idle = idleSeconds()
    let p: Presence = (idle ?? .infinity) < window ? .here : .away
    return PresenceSample(presence: p, idleSeconds: idle, at: now)
  }

  /// Seconds since any mouse/keyboard event across the login session. CGEventSource
  /// answers this without accessibility rights; it answers a very large number
  /// when it cannot, which `sample` reads as away.
  public static func idleSeconds() -> Double? {
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel]
    var best: Double?
    for t in types {
      let s = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: t)
      if s.isFinite, s >= 0 { best = min(best ?? s, s) }
    }
    return best
  }

  /// Pure: what a given idle reading means. For the test.
  public static func classify(idleSeconds: Double?) -> Presence {
    (idleSeconds ?? .infinity) < window ? .here : .away
  }
}
