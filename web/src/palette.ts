/**
 * One hue per domain, assigned by the order the API returns them (most open
 * first), so the busiest domains get the most separable colours. Tuned for a
 * dark canvas: high chroma, similar lightness, no two adjacent hues within 30°.
 */
const HUES = [190, 28, 265, 140, 330, 55, 215, 0, 100, 300, 240, 165, 15, 280, 75];

export interface DomainStyle {
  hue: number;
  /** The node fill for an open entity. */
  core: string;
  /** The soft cluster blob. */
  wash: string;
  /** Labels and hull edges. */
  ink: string;
}

export function domainStyles(domains: string[]): Map<string, DomainStyle> {
  const out = new Map<string, DomainStyle>();
  domains.forEach((d, i) => {
    const hue = HUES[i % HUES.length]!;
    out.set(d, {
      hue,
      core: `hsl(${hue} 80% 62%)`,
      wash: `hsl(${hue} 70% 50%)`,
      ink: `hsl(${hue} 60% 78%)`,
    });
  });
  return out;
}

/** How a pulse looks when it lands on a node. */
export const PULSE_COLOR: Record<string, string> = {
  probe: 'hsl(190 90% 70%)',
  'entity-change': 'hsl(45 100% 65%)',
  focus: 'hsl(320 90% 70%)',
  call: 'hsl(140 85% 65%)',
  friction: 'hsl(0 90% 65%)',
  turn: 'hsl(220 90% 72%)',
  tool: 'hsl(220 40% 70%)',
  operator: 'hsl(280 90% 72%)',
  life: 'hsl(160 70% 55%)',
};
