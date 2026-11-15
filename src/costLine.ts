/**
 * THE COST LINE, rendered. Pure over a tally (db.ts costTally) so its shape is
 * pinned by a test rather than by reading cycleCli's output on a good day.
 * The three roles that always spend are always printed — a zero is the
 * finding when a day was quiet — and every role names the model it ran and
 * the effort it ASKED for, because that is the only way a model or effort
 * change shows up as a number instead of a feeling.
 */
import type { CostTally } from './db.js';

export function costLine(t: CostTally): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const roles = t.roles
    .filter((r) => r.turns > 0 || r.role === 'concierge' || r.role === 'worker' || r.role === 'night')
    .map((r) => {
      if (!r.turns) return `${r.role} no turns`;
      const split = r.models
        .map((m) => `${m.model || '?'}${m.effort ? `/${m.effort}(asked)` : ''} ${usd(m.usd)} ×${m.turns}`)
        .join(', ');
      return `${r.role} ${usd(r.usd)} over ${r.turns} turn(s) at ${usd(r.usd / r.turns)}/turn [${split}]`;
    });
  return `  -> COST: ${usd(t.total)} over ${t.turns} turn(s) — ${roles.join(' · ')}`;
}
