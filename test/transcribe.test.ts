import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanTranscript, spokenNote, transcribe } from '../src/transcribe.js';

/**
 * VOICE IN — the parts that do not need a model.
 *
 * The model itself is a 1.6 GB file on one machine; a test that needs it is a
 * test that runs nowhere else. What CAN be pinned: the failure path never
 * throws (a hung or missing model must not take the day door with it), the
 * cleaner strips what whisper prints that nobody said, and the tag the
 * concierge reads is stable.
 */

describe('voice in', () => {
  it('fails softly when the audio does not exist', async () => {
    const r = await transcribe('/nonexistent/note.oga');
    assert.ok('problem' in r, 'a missing file must be a problem, not a throw');
  });

  it('strips non-speech tokens and joins segments into one line', () => {
    assert.equal(cleanTranscript('[BLANK_AUDIO]\n I ordered the salad today.\n\n and walnuts, gerdoo.\n[_BEG_]'), 'I ordered the salad today. and walnuts, gerdoo.');
    assert.equal(cleanTranscript('[MUSIC]\n\n'), '');
  });

  it('tags a spoken note so every reader knows what kind of evidence it is', () => {
    const t = spokenNote('hello', 75);
    assert.match(t, /^🎤 \[voice note, 1:15, transcribed locally/);
    assert.ok(t.endsWith('\nhello'));
  });
});
