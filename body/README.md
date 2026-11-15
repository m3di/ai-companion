# body — Companion.app

The native Mac window of the companion (round 12, `docs/plans/round-12-the-body.md`):
the STAGE in the middle, WIDGETS snapped around it, every widget a live render
of the bot's Atlas (`ATLAS_PORT`, default 7391). The app owns one piece of state,
the layout file; everything it shows belongs to the bot and is re-read when the
stream says it moved.

One command runs everything: `npm run start` in the bot's directory spawns the
built app as a child (`src/body.ts`). The bot stopping kills the app; the app
quitting stops the bot; a bot that dies without a shutdown is noticed by the
app, which quits itself. `COMPANION_APP=0 npm run start` runs the bot alone.

```bash
npm run body                # build Companion.app (release) — once, and after a Swift change
npm run start               # the bot, and the app with it
./companion                 # the app alone, for working on it
./companion restart         # load a new build into a running one
./companion test            # the gate: swift run bodykit-check (no XCTest without Xcode)
.build/debug/companion-app --stream-test 6            # does /api/stream deliver? (needs the bot)
.build/debug/companion-app --layout /tmp/l.json --appearance dark --snapshot /tmp/a.png --size 1300x840
```

Layout: `~/Library/Application Support/Companion/layout.json`, written 400 ms after
the last move. A test run passes `--layout` so it never touches that file.

Parts, in order (each landed with a dated line in the round plan):

1. **The shell and its observability** — the stage's shape, the widget board
   (move, resize, snap to the window, the stage and each other, collapse to a
   pill), vitals / live feed / focus / this-app / graph widgets, presence
   (binary, from HID idle), a log of the app's own events.
2. The microphone: click to start, click to stop, the transcript colour-coded.
3. The prompt: text + transcript sent as one turn, "thinking" shown.
4. The reply: text, spoken, shown, buttons, and "sent to Telegram" in the stream.
5. The native pass on the Atlas inside the web view.
6. `show()` — the bot draws on the canvas.
