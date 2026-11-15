import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { getVoicePrefs } from './db.js';
import { voiceDir } from './transcribe.js';

/**
 * VOICE OUT — text becomes a voice message, locally, before it reaches the
 * transport. The mirror of src/transcribe.ts and built on the same argument:
 * the transport's whole job is to send a FILE, so the voice survives a change
 * of transport, and nothing Mehdi is told leaves this machine to be spoken.
 *
 * Piper (rhasspy) in an isolated Python environment under ~/piper — a
 * subprocess, like a probe and like whisper-cli, so the bot itself has no
 * Python dependency and a hung synthesis cannot hold a turn. Voices are one
 * .onnx file each under ~/piper/voices; `/voice samples` sends every one so
 * Mehdi can pick by ear, and the pick is stored per chat (`voice_prefs`).
 *
 * WHEN to speak is not decided here. The concierge's sendVoice tool is the
 * only caller besides the calibration command, and the prompt gates it on the
 * selection the goal work built: a spoken message is for the few things worth
 * a conversation, never for the daily loop.
 */

export interface VoiceInfo {
  name: string;
  /** From the voice's sidecar json, when present: "en_US", "fa_IR". */
  language?: string;
  quality?: string;
}

export interface Spoken {
  path: string;
  /** Seconds of audio, from the file size at Telegram's opus rate. */
  seconds: number;
  voice: string;
  ms: number;
}

/**
 * What the calibration samples say — GENERIC on purpose (a sample is for the
 * ear, not the diary), and in the voice's own language: a Persian voice reading
 * English says nothing about how it sounds on Persian. A weekday and a number
 * in each, because those are what a voice gets wrong.
 */
const SAMPLE_TEXTS: Record<string, string> = {
  en: 'This is a sample of the assistant\'s voice. For calibration, a day and a number: Tuesday at nine, and forty-two. Is the pace and the tone right for you?',
  fa: 'این یک نمونه از صدای دستیار است. برای تنظیم، یک روز و یک عدد: سه‌شنبه ساعت نه، و چهل و دو. آیا سرعت و لحن برای شما مناسب است؟',
};
export function sampleTextFor(language?: string): string {
  return SAMPLE_TEXTS[(language ?? 'en').slice(0, 2).toLowerCase()] ?? SAMPLE_TEXTS.en!;
}

const DEFAULT_VOICE = 'en_US-lessac-medium';
const DEFAULT_RATE = 1.0;

export function voicesDir(): string {
  return resolve(config.piperVoicesDir.replace(/^~/, process.env.HOME ?? ''));
}

export function listVoices(): VoiceInfo[] {
  const dir = voicesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.onnx') && statSync(join(dir, f)).size > 1_000_000)
    .map((f) => {
      const name = f.replace(/\.onnx$/, '');
      const m = name.match(/^([a-z]{2}_[A-Z]{2})-.+-(x_low|low|medium|high)$/);
      return { name, language: m?.[1], quality: m?.[2] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The bot can speak, or why it cannot. Free to call; nothing runs. */
export function voiceOutStatus(): { ready: true; voices: VoiceInfo[] } | { ready: false; problem: string } {
  const bin = resolve(config.piperBin.replace(/^~/, process.env.HOME ?? ''));
  if (!existsSync(bin)) return { ready: false, problem: `no piper at ${bin} — set PIPER_BIN, or: python3 -m venv ~/piper/venv && ~/piper/venv/bin/pip install piper-tts` };
  const voices = listVoices();
  if (!voices.length) return { ready: false, problem: `no voices under ${voicesDir()} — download .onnx + .onnx.json pairs from https://huggingface.co/rhasspy/piper-voices` };
  return { ready: true, voices };
}

/** The chat's pick, or the default. `rate` is Piper's length_scale: 1 = as trained, 0.85 = brisker. */
export function voiceChoice(chatId: number): { voice: string; rate: number } {
  const p = getVoicePrefs(chatId);
  return { voice: p?.voice ?? DEFAULT_VOICE, rate: p?.rate ?? DEFAULT_RATE };
}

function run(cmd: string, args: string[], stdin: string | undefined, timeoutMs: number): Promise<{ ok: true } | { ok: false; err: string }> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) done({ ok: false, err: `${err.message}${stderr ? `\n${String(stderr).slice(-400)}` : ''}` });
      else done({ ok: true });
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/**
 * Text as it should be SAID: no markup, no links read out letter by letter,
 * no bullets. What a person would say if they were reading it to you.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+$/, '');
}

/** Synthesise `text` to an opus file Telegram plays as a voice message. */
export async function speak(text: string, opts: { voice?: string; rate?: number; chatId?: number; timeoutMs?: number } = {}): Promise<Spoken | { problem: string }> {
  const t0 = Date.now();
  const status = voiceOutStatus();
  if (!status.ready) return { problem: status.problem };
  const chosen = opts.chatId !== undefined ? voiceChoice(opts.chatId) : { voice: DEFAULT_VOICE, rate: DEFAULT_RATE };
  const voice = opts.voice ?? chosen.voice;
  const rate = opts.rate ?? chosen.rate;
  const model = join(voicesDir(), `${voice}.onnx`);
  if (!existsSync(model)) return { problem: `no voice "${voice}" — one of: ${status.voices.map((v) => v.name).join(', ')}` };
  const said = cleanForSpeech(text);
  if (!said) return { problem: 'nothing to say' };

  const dir = join(voiceDir(), 'out');
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, `${Date.now().toString(36)}-${voice}`);
  const wav = `${stem}.wav`;
  const ogg = `${stem}.ogg`;
  const bin = resolve(config.piperBin.replace(/^~/, process.env.HOME ?? ''));
  const synth = await run(bin, ['--model', model, '--output_file', wav, '--length_scale', String(rate)], said, opts.timeoutMs ?? 120_000);
  if (!synth.ok) return { problem: `piper failed: ${synth.err}` };
  try {
    const conv = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', ogg], undefined, 60_000);
    if (!conv.ok) return { problem: `ffmpeg could not encode the voice: ${conv.err}` };
  } finally {
    try {
      unlinkSync(wav);
    } catch {
      /* gone */
    }
  }
  const seconds = Math.round(statSync(ogg).size / 4000);
  return { path: ogg, seconds, voice, ms: Date.now() - t0 };
}
