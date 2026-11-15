import { useEffect, useRef, useState } from 'react';
import type { GraphView, Pulse } from './types';

/** Fetch the graph once, and again on demand. */
export function useGraph(): { graph: GraphView | null; error: string | null; reload: () => void } {
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    fetch('/api/graph')
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
      .then((g: GraphView) => live && (setGraph(g), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [nonce]);

  return { graph, error, reload: () => setNonce((n) => n + 1) };
}

/**
 * The live feed.
 *
 * `EventSource` reconnects on its own, which is the entire reason this is SSE
 * and not a socket. Pulses are kept in two places on purpose: a bounded list for
 * the ticker (React state, re-renders), and a ref the canvas reads every frame
 * (no re-render — a probe sweep emits ~56 pulses in a few seconds and must not
 * cost 56 React renders).
 */
export function usePulses(onPulse: (p: Pulse) => void): { recent: Pulse[]; connected: boolean } {
  const [recent, setRecent] = useState<Pulse[]>([]);
  const [connected, setConnected] = useState(false);
  const cb = useRef(onPulse);
  cb.current = onPulse;

  useEffect(() => {
    const es = new EventSource('/api/stream');
    const seen = new Set<number>();
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      const p = JSON.parse(ev.data) as Pulse;
      // The replay on connect overlaps whatever a reconnect already delivered.
      if (seen.has(p.seq)) return;
      seen.add(p.seq);
      cb.current(p);
      setRecent((r) => [p, ...r].slice(0, 40));
    };
    return () => es.close();
  }, []);

  return { recent, connected };
}

export interface TurnStep {
  step: string;
  refs: string[];
}

export interface Proposal {
  id: number;
  summary: string;
  steps: string[];
}

export interface WatchedTurn {
  runId: number;
  text: string;
  steps: TurnStep[];
  status: 'running' | 'done' | 'error';
  error?: string;
  costUsd?: number;
  /** Every node the turn has reached for, in order of first touch. */
  reached: string[];
  /** A plan waiting on the operator. Arrives mid-turn — the buttons show up
   *  the moment it is offered, before the agent has finished writing. */
  proposal?: Proposal;
}

/**
 * WATCH ONE TURN as it happens.
 *
 * Separate from `usePulses` because the two carry different kinds of thing.
 * Pulses are the machine's ambient activity — lossy, replayed loosely, a
 * dropped one costs a frame. This carries an ANSWER, where a dropped fragment
 * costs a sentence out of the middle and the reader cannot tell. The server
 * replays the whole buffer on connect for exactly that reason, so a reconnect
 * mid-turn is seamless.
 *
 * Closes itself when the turn ends: an EventSource kept open on a finished turn
 * would reconnect forever against a stream that will never speak again.
 */
export function useTurn(runId: number | null): WatchedTurn | null {
  const [turn, setTurn] = useState<WatchedTurn | null>(null);

  useEffect(() => {
    if (runId === null) {
      setTurn(null);
      return;
    }
    setTurn({ runId, text: '', steps: [], status: 'running', reached: [] });
    const es = new EventSource(`/api/agent/turn/${runId}/stream`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      setTurn((prev) => {
        const t: WatchedTurn = prev ?? { runId, text: '', steps: [], status: 'running', reached: [] };
        switch (ev.kind) {
          case 'replay':
            return { ...t, text: ev.text, steps: ev.steps, status: ev.status, reached: ev.reached, proposal: ev.proposal };
          case 'proposal':
            return { ...t, proposal: { id: ev.id, summary: ev.summary, steps: ev.steps } };
          case 'delta':
            return { ...t, text: t.text + ev.text };
          case 'step':
            return {
              ...t,
              steps: [...t.steps, { step: ev.step, refs: ev.refs }],
              reached: [...t.reached, ...ev.refs.filter((r: string) => !t.reached.includes(r))],
            };
          case 'done':
            return { ...t, text: ev.text || t.text, costUsd: ev.costUsd, status: 'done' };
          case 'error':
            return { ...t, status: 'error', error: ev.message };
          default:
            return t;
        }
      });
      if (ev.kind === 'done' || ev.kind === 'error') es.close();
    };
    // No onerror retry: the server ends the stream when the turn ends, and a
    // browser treats a clean close as a disconnection to recover from.
    es.onerror = () => es.close();
    return () => es.close();
  }, [runId]);

  return turn;
}
