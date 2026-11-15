# Round 12 — The body: a second transport that knows where Mehdi is

_Set down 2026-10-05, from the conversation after Lisbon. Written so a fresh
agent can pick it up, plan a step, and build — read the Charter first
(`docs/CHARTER.md`), then this, then `~/Projects/reflex/docs/DESIGN.md` for the
body's own history, then the seams named at the bottom._

---

## The decision, in Mehdi's words

> Telegram means I'm away from my laptop and talking live to the whole system.
> Talking to it with a Swift app means I'm next to it. It also becomes aware of
> the environment and my physical position (now binary), so it can decide when
> something happens to call me out loud — "hey Mehdi, are you around?" — if I
> allowed it; if rejected or the setting is off, the only way becomes a Telegram
> message. Things become mixed: not everything happens on Telegram. Daily
> routines can happen when I'm talking to the laptop in the morning. We don't
> need to show worker state or scheduled triggers on Telegram anymore — Telegram
> only shows these if I asked for them on Telegram; the bot decides. But
> everything should be visible in the main UI.

And the architecture agreed the same hour: **the Node bot stays the brain, the
Swift app is the body, the Atlas is the canvas.** Reflex's own planner, scribe,
conductor and pulse — a second brain with its own state — are retired, not
ported. "No complex state that we provided in reflex: we have our own here; the
bot session itself has lots of things to have a state, and the night optimises
it."

## What this is, in Charter terms

- **Milestone: M7's "second transport"**, taken first because it is the half of
  M7 that needs no F1 decision — one person, two doors. The transport contract
  (`src/transport/types.ts`) says in its own comment that a second consumer is
  what should drive the format abstraction. This is that consumer.
- **I12.** Presence moves per minute. It may NEVER enter the concierge's prefix
  or its session-open snapshot. It is read at DELIVERY time by the router, and
  passed in a turn only when the turn is about it (a call-out, a "where is he").
- **I9.** Routing is a mechanism at the one outbound funnel, not a paragraph
  asking the concierge to pick a channel. Today `adapter.send(` has **72 call
  sites**; the round ends with one `deliver(class, msg)` they all go through.
- **I1 / I2.** The canvas is a RENDER. Story root, commitments, focus, notes,
  the graph, worker cards — every panel is a lens over the store the night
  already maintains (`/api/lens/*`, `/api/graph`, `/api/vitals`, `/api/runs`).
  Nothing shown in the app is held by the app.
- **I10.** "Everything should be visible in the main UI" is I10 said by its
  owner. The Atlas becomes the one place where every delivery, of every class,
  is visible — including what went to Telegram and what was spoken.
- **I8.** A call-out that cannot be heard must fall through, by mechanism, to
  Telegram. Silence is never the result of a routing decision.

## The two facts the router works from

**Presence** — binary for now, measured by the body and reported to the bot:

| state | meaning | evidence (any one) |
|---|---|---|
| `here` | next to the laptop | the app is running AND (spoke in the last N min, or HID idle < N min with the screen unlocked) |
| `away` | not | everything else, including "the app is not running" |

The bot stores the latest report with its timestamp (`presence` table, one row
per chat). A stale report (older than its own TTL) reads as `away`. The Atlas
shows the chip.

**Call-out permission** — a setting, with a per-event answer on top:

- setting `callout` ∈ { `on`, `off` } (`/callout on|off`, the Atlas, the app).
- when `on` and `here`, a time-sensitive delivery is SPOKEN first: "Hey Mehdi,
  are you around? …" If he answers (voice or click) within the window, the
  conversation continues in the app. If he does not, or says no, the same
  content goes to Telegram. The decision is logged with the delivery.

## The routing rule — one table, applied at the funnel

Every outbound carries a **class**. The class is set by the caller, which
already knows what it is sending; the router decides where.

| class | here | away | always |
|---|---|---|---|
| `reply` (answer to a turn) | the transport the turn came from | the transport the turn came from | Atlas feed |
| `callout` (needs him now: a question, a failure) | voice, then Telegram if unanswered | Telegram | Atlas feed |
| `notice` (worker done, dispatch, scheduled trigger, routine, night report) | app only | **nothing**, unless he asked on Telegram | Atlas feed |
| `asked-for` (he ran a command on a transport) | that transport | that transport | Atlas feed |

"Unless he asked on Telegram" is state the router holds, not judgement: a
Telegram command sets a short-lived `telegram-attending` flag, and notices flow
to Telegram while it is set. The concierge may ALSO escalate a `notice` to a
`callout` — that is the one place its judgement enters, and it is a tool call
with a reason, logged.

Morning routine on a `here` morning: it runs as a conversation in the app
(spoken brief, buttons in the command bar) and never reaches the phone.

## The body (Swift, macOS 26)

Keep from reflex, as they are: `Ear.swift` (SpeechAnalyzer streaming with
confidence), `Voice.swift` (Kokoro warm, barge-in), `Orb.swift`, `CommandBar`
(labels you can say or click), `Session.presence` (the attention states — the
source of `here`/`away`). Retire: `Scene`, `Stage`, `Scribe`, `Conductor`,
`Claude.swift`, `brain/*` prompts, the watchers. The app has no model calls.

Talks to the bot over **one WebSocket on localhost** (`ReflexAdapter`,
implementing `ChatTransport`): inbound text (from speech or typed) and button
taps up; messages, buttons, edits and `speak` text down. Voice OUT is TEXT on
this transport: the app speaks it with the warm local voice (~0.4 s) instead
of the bot rendering an ogg for Telegram. `sendVoice` keeps its file path for
the phone.

Presence goes up the same socket, on change and every TTL/2.

## The canvas (the Atlas inside a WKWebView), and what "native" means here

The web view hosts the Atlas directly; it already streams from `/api/stream`.
The app never proxies the data. The bridge (`webkit.messageHandlers`) carries
only native things: speak this, open in Safari, the command bar's labels.

"Best experience of a native Swift app" is a list, each item checkable:

1. **No seam.** `drawsBackground = false`, the page's `body` transparent over
   an `NSVisualEffectView`; `-apple-system` type; `prefers-color-scheme` wired
   to the window's appearance; no browser scrollbars (`overlay`), no text
   selection on chrome, no context menu on the graph.
2. **Trackpad.** Pinch zooms the graph, two-finger pans, no scroll bounce in
   panels that are not lists.
3. **Idle cost.** Target under 2 % of a core with the window open and the
   graph still — the same bar reflex met. The force simulation must STOP when
   settled and only wake on a write (`live.ts` already receives them); the
   ticker must not re-render the graph; SSE reconnects must not re-layout.
4. **First paint.** The graph appears from a cached layout (positions saved in
   `localStorage` by node id) and settles from there; no 3-second explosion on
   every open.
5. **Panels are lenses.** Story root, focus, commitments, notes, runs, vitals,
   the deliveries feed — each a route, each reachable from the command bar by
   voice ("show commitments"), none holding state.
6. **The feed.** A deliveries panel showing every outbound with its class and
   where it went (spoken / app / Telegram / dropped-as-notice), the router's
   log made visible (I10).

## Landed

- **2026-10-05 — Part 1 of the app: the shell and its observability.** `body/`
  is its own Swift package next to the bot (reflex's tree was mid-change and
  uncommitted, and the app is one half of a protocol the other half of which
  lives here): `BodyKit` (the Atlas client with a byte-level SSE reader —
  `URLSession.AsyncBytes.lines` delivered nothing for 6 s where raw bytes gave
  the 80-pulse replay at once; the snapping geometry; the layout file; presence
  from HID idle; the app's own log) and `companion-app` (the stage's shape,
  the widget board — move, resize, snap to window/stage/each other, collapse to
  a pill, anchored re-layout on resize — and the first widgets: vitals, live
  feed, focus, this-app, graph-in-a-web-view). `./companion` builds the bundle;
  `./companion test` runs `bodykit-check` (53 checks; no XCTest without Xcode);
  `--stream-test`, `--snapshot`, `--layout` for runs that touch nothing of his.
  Verified against the live Atlas: vitals, the focus lens and the stream
  arrive; presence reads `here` at the keyboard. Not measured yet: idle cost.

1. **`deliver()` and the class.** One funnel in `src/dispatch.ts`; the 72 call
   sites pass a class; the router has one transport and one rule (everything to
   it) so behaviour is unchanged. The deliveries log table and `/api/deliveries`.
   _Number:_ 0 sends outside the funnel (a lint over `src/` for `adapter.send(`).
2. **`ReflexAdapter` + presence.** The WebSocket transport, the `presence` table
   and chip, `/api/presence`. Both adapters constructed in `index.ts`, same
   chat. The Swift app cut down to Ear + Voice + Orb + CommandBar + a WKWebView
   on the Atlas, speaking to the socket. _Number:_ turns per day by transport in
   `cycleCli`; seconds from his last word to its first.
3. **The routing table.** Classes route per the table above; `telegram-attending`;
   the Telegram stream goes quiet by mechanism. _Number:_ Telegram messages per
   day by class — `notice` must fall to the ones he asked for.
4. **The call-out.** Setting, the spoken question, the answer window, the
   fall-through, the log. _Number:_ call-outs answered vs fallen through.
5. **The canvas, native.** The six items above, each measured (idle %, first
   paint ms, a screenshot in both appearances).
6. **`show()`.** The concierge's on-demand canvas tool: a card, a table, a
   Mermaid block, pushed over the socket, rendered by the Atlas, logged as a
   delivery. _Number:_ shows per day and whether he looked (the panel's open
   events).

Steps 1 and 3 touch nothing Swift and are safe to land while the phone is the
only body: with one transport the table collapses to "send it".

## Open questions (decide at the step, not before)

- The `here` thresholds (N minutes idle, voice recency, the TTL). Start with
  reflex's measured ones: 10 s in another app → not attending, 30 s silence;
  `here` is looser than "attending" — around the desk, not watching the window.
- Whether a `reply` to a voice turn is spoken in full or spoken as a line with
  the rest on the canvas. Probably the latter; measure how often he asks "read
  it".
- Whether the morning routine's buttons live in the command bar or on the
  canvas. Both are the same `Buttons` type; the body decides.
- iOS later: the same body with `AVSpeechSynthesizer` or a CoreML voice in place
  of Kokoro. Not this round.

## Seams

- `src/transport/types.ts` — the contract; `src/transport/telegram.ts` — the
  first adapter; `src/index.ts:22` — where adapters are constructed.
- `src/dispatch.ts` — the 72 `adapter.send(` sites that become `deliver()`.
- `src/speak.ts` — voice out as a file; keeps serving Telegram.
- `src/atlas.ts` — `/api/stream`, `/api/lens/*`, `/api/graph`, `/api/vitals`,
  `/api/runs`; `web/src/live.ts` — the SSE client; `web/src/Atlas.tsx` — the
  force graph (react-force-graph-2d, canvas renderer).
- `~/Projects/reflex/Sources/reflex-app/{Ear,Voice,Orb,CommandBar,Session}.swift`
  — what the body keeps.
