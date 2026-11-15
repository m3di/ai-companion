/** Mirrors the shapes `modules/entities` returns. Kept by hand and deliberately
 *  small: the client must not grow a private model of the graph. */

export interface Node {
  id: string;
  domain: string;
  kind: string;
  status: 'open' | 'closed' | 'n/a';
  state?: string;
  state_at?: string;
  actor?: string;
  dormant: boolean;
  goal: boolean;
  degree: number;
  gist?: string;
  probed: boolean;
  // Written by the force simulation.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

export interface Link {
  source: string | Node;
  rel: string;
  target: string | Node;
}

export interface DomainSummary {
  domain: string;
  entities: number;
  open: number;
  closed: number;
  criticalPath?: string[];
  kinds: string[];
}

export interface GraphView {
  nodes: Node[];
  links: Link[];
  domains: DomainSummary[];
  errors: string[];
  generatedAt: string;
}

export type PulseKind = 'probe' | 'entity-change' | 'focus' | 'call' | 'friction' | 'turn' | 'tool' | 'operator' | 'observe' | 'life';

export interface Pulse {
  seq: number;
  at: string;
  kind: PulseKind;
  text: string;
  refs?: string[];
  domains?: string[];
  loud?: boolean;
  meta?: Record<string, unknown>;
}

export interface Line {
  id: string;
  kind: string;
  status: string;
  state?: string;
  actor?: string;
  blockedBy?: string[];
  dormant?: boolean;
  gist?: string;
}

export interface Neighbour extends Line {
  rel: string;
  direction: 'out' | 'in';
}

export interface Detail {
  card: {
    id: string;
    domain: string;
    kind: string;
    aka: string[];
    status: string;
    state?: string;
    state_at?: string;
    actor?: string;
    dormant: boolean;
    goal: boolean;
    facts: string[];
    edges: Record<string, string[]>;
    chain: string[];
    note?: string;
    probe?: string;
  };
  neighbours: Neighbour[];
  stats: {
    id: string;
    degree: number;
    byRelation: string[];
    openBlockers: number;
    hopsToGoal?: number;
    stateAgeDays?: number;
    domainOpen: number;
  } | null;
  blockers: Line[];
  trace: string[];
}
