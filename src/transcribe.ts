import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from './config.js';

/**
 * VOICE IN — a spoken note becomes text, locally, before it reaches the door.
 *
 * Why this exists: after two months Mehdi said he will not sit and type about
 * his diet or his health every day — he did it once to test, and the second
 * time was not worth typing. The topics the machine most needs answers on are
 * the ones a keyboard makes too expensive to answer, so the walnut plan sat
 * unanswered for eight weeks. A voice note is the channel in which the answer
 * actually gets given.
 *
 * Why it is its own module and not a transport feature: Telegram sells
 * transcription as a Premium feature, and a feature bought from the transport
 * is lost with the transport. Here the transport's whole job is to hand over
 * an audio FILE; this module turns a file into text with a local model
 * (whisper.cpp) and never learns which app the file came from. Health talk
 * stays on this machine.
 *
 * Deliberately a subprocess, like a probe: no Python runtime in the bot, and a
 * model that hangs cannot hang the process (bounded by a timeout).
 */

export interface Transcript {
  text: string;
  /** Wall time of the whole pipeline, for the ledger. */
  ms: number;
}

export interface TranscribeFailure {
  problem: string;
}

/** The model the bot will use, or why it cannot. Free to call; nothing runs. */
export function voiceStatus(): { ready: true; model: string } | { ready: false; problem: string } {
  const model = config.whisperModel;
  if (!existsSync(model)) {
    return {
      ready: false,
      problem:
        `no Whisper model at ${model} — download one (e.g. ggml-large-v3-turbo.bin from ` +
        `https://huggingface.co/ggerganov/whisper.cpp) or set WHISPER_MODEL`,
    };
  }
  return { ready: true, model };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) done({ ok: false, err: `${err.message}${stderr ? `\n${String(stderr).slice(-400)}` : ''}` });
      else done({ ok: true, out: String(stdout) });
    });
  });
}

/**
 * Turn an audio file (any container ffmpeg reads — Telegram sends opus in ogg)
 * into text. The intermediate 16 kHz mono wav is deleted; the original is
 * left where it was, so a better model can re-read it later.
 */
export async function transcribe(audioPath: string, opts: { language?: string; timeoutMs?: number } = {}): Promise<Transcript | TranscribeFailure> {
  const t0 = Date.now();
  const status = voiceStatus();
  if (!status.ready) return { problem: status.problem };
  if (!existsSync(audioPath)) return { problem: `no audio file at ${audioPath}` };

  const wav = `${audioPath}.16k.wav`;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const conv = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60_000);
  if (!conv.ok) return { problem: `ffmpeg could not read the audio: ${conv.err}` };

  try {
    const language = opts.language ?? config.whisperLanguage;
    const r = await run(config.whisperBin, ['-m', status.model, '-f', wav, '-l', language, '-nt', '-np', '-t', '4'], timeoutMs);
    if (!r.ok) return { problem: `whisper failed: ${r.err}` };
    const text = cleanTranscript(r.out);
    if (!text) return { problem: 'whisper heard nothing it could write down' };
    return { text, ms: Date.now() - t0 };
  } finally {
    try {
      unlinkSync(wav);
    } catch {
      /* already gone */
    }
  }
}

/** whisper-cli's stdout with -nt: one line per segment, blank lines, and the
 *  bracketed non-speech tokens it emits for music or silence. */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/\[(BLANK_AUDIO|MUSIC|SILENCE|_[A-Z_]+_)\]/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How a spoken note reads to the concierge. The tag is in the TEXT rather than
 * in a field because the transcript is the one thing every reader shares — the
 * day, the night's digest, `readMessage` — and a spoken note is a different
 * kind of evidence: looser, longer, and the answer to things the keyboard never
 * got. Duration says how much was said; "transcribed locally" says how much to
 * trust the spelling of names.
 */
export function spokenNote(text: string, durationSec: number): string {
  const m = Math.floor(durationSec / 60);
  const s = Math.round(durationSec % 60);
  return `🎤 [voice note, ${m}:${String(s).padStart(2, '0')}, transcribed locally — names and numbers may be misheard]\n${text}`;
}

/** Where the transport parks incoming audio. Under data/, so never in git. */
export function voiceDir(): string {
  const dir = resolve(config.voiceDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEFAULT_WHISPER_MODEL = join(homedir(), 'whisper-models', 'ggml-large-v3-turbo.bin');
