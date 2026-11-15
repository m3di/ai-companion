import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getVoicePrefs, setVoicePrefs } from '../src/db.js';
import { cleanForSpeech, speak, voiceChoice } from '../src/speak.js';

/**
 * VOICE OUT — the parts that need no model: text is cleaned into speech, the
 * chat's pick round-trips, and a bad voice or a missing engine is a problem
 * handed back, never a throw that takes a turn with it.
 */

describe('voice out', () => {
  it('turns Telegram-flavoured text into something a person would say', () => {
    assert.equal(cleanForSpeech('<b>PR #3510</b> is ready — see https://github.com/x/y/pull/3510\n- review it\n- then merge'), 'PR 3510 is ready — see a link. review it. then merge');
    assert.equal(cleanForSpeech('  \n\n '), '');
  });

  it('keeps the chat\'s pick, with a default before any pick', () => {
    const chat = 987654321;
    assert.equal(getVoicePrefs(chat), undefined);
    assert.equal(voiceChoice(chat).rate, 1);
    setVoicePrefs(chat, { voice: 'en_US-ryan-high' });
    setVoicePrefs(chat, { rate: 0.9 });
    assert.deepEqual(voiceChoice(chat), { voice: 'en_US-ryan-high', rate: 0.9 });
  });

  it('refuses softly: a voice that is not installed, and nothing to say', async () => {
    const r = await speak('hello', { voice: 'xx_XX-nobody-low' });
    assert.ok('problem' in r);
    const empty = await speak('   ', { voice: 'en_US-lessac-medium' });
    assert.ok('problem' in empty);
  });
});
