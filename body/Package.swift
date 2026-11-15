// swift-tools-version: 6.2
import PackageDescription

// The body (round 12): a native Mac window around the Atlas. BodyKit holds
// everything that can be tested without a window — the Atlas client, the SSE
// parser, the snapping geometry, the layout file, the app's own state — and
// companion-app is the window over it, bundled into Companion.app by ./companion.
let package = Package(
  name: "body",
  platforms: [.macOS(.v26)],
  targets: [
    .target(name: "BodyKit", swiftSettings: [.swiftLanguageMode(.v5)]),
    .executableTarget(name: "companion-app", dependencies: ["BodyKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    // The gate (no XCTest without Xcode): `swift run bodykit-check`, or ./companion test.
    .executableTarget(name: "bodykit-check", dependencies: ["BodyKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
