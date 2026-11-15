import BodyKit
import SwiftUI

// THE STAGE — the fixed shape in the middle that everything snaps around.
// Part 1 draws its frame and its three bands: a header with the three chips
// (connection · mode · presence), the stream (empty until part 4), and the
// prompt bar (inert until part 3). The shape is the contract the widgets lay
// out against, so it is drawn now, in full size, with nothing in it yet.

struct StageView: View {
  let state: AppState
  let take: Take

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().opacity(0.5)
      stream
      if take.phase != .idle {
        TakeView(take: take).padding(.horizontal, 14).padding(.bottom, 10)
      }
      Divider().opacity(0.5)
      promptBar
    }
    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.background.opacity(0.55)))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.stage.opacity(0.35), lineWidth: 1))
    .shadow(color: .black.opacity(0.18), radius: 28, y: 12)
  }

  private var header: some View {
    HStack(spacing: 14) {
      Text("Companion").font(.system(.title3, design: .rounded).weight(.semibold))
      Spacer()
      Chip(dot: connectionColor, text: "stream " + state.connection.label)
      Chip(dot: modeColor, text: "bot " + (state.vitals?.mode ?? "?"))
      Chip(dot: state.presence.presence == .here ? Palette.here : Palette.away, text: "you " + state.presence.presence.rawValue)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
  }

  private var stream: some View {
    VStack(spacing: 10) {
      Spacer()
      Image(systemName: "text.alignleft").font(.system(size: 28)).foregroundStyle(.tertiary)
      Text("The stream").font(.headline).foregroundStyle(.secondary)
      Text("The bot's output lands here, newest at the bottom — text, what it showed, what it spoke, what it sent to Telegram. Part 4.")
        .font(.callout).foregroundStyle(.tertiary).multilineTextAlignment(.center).frame(maxWidth: 420)
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var promptBar: some View {
    HStack(spacing: 10) {
      MicButton(take: take)
      Text(take.isListening ? "Listening… click the microphone to stop" : "Type, or click the microphone — sending is part 3").foregroundStyle(.tertiary)
      Spacer()
      Image(systemName: "arrow.up.circle").font(.title2).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
  }

  private var connectionColor: Color {
    switch state.connection {
    case .connecting: return .yellow
    case .live: return Palette.live
    case .lost: return Palette.lost
    }
  }

  private var modeColor: Color {
    switch state.vitals?.mode {
    case "live": return .green
    case "debug": return .orange
    case "dreaming": return Palette.stage
    default: return .gray
    }
  }
}

struct Chip: View {
  let dot: Color
  let text: String
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(dot).frame(width: 7, height: 7)
      Text(text).font(.caption.monospaced())
    }
    .padding(.horizontal, 9).padding(.vertical, 4)
    .background(Capsule().fill(Color.primary.opacity(0.06)))
  }
}
