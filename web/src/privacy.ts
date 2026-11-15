import { useCallback, useEffect, useState } from 'react';

/**
 * PRIVATE DOMAINS — a screenshare guard, and nothing more.
 *
 * The Atlas is the operator's backdoor into everything the system knows, which
 * is exactly what makes it unshowable: `paperwork` and `personal` are on the
 * same canvas as the work domains, and the demo Mehdi wants to give a colleague
 * is the work half.
 *
 * So a private domain keeps its SHAPE and loses its CONTENT. Its nodes are still
 * drawn, still positioned, still connected — the graph reads the same, and an
 * edge crossing into it still says "this touches something else" — but no name,
 * no state, no fact, and no hover reaches the screen. What is hidden is legible
 * as hidden: a lock, not a gap, because a silently missing cluster would make
 * the picture a lie.
 *
 * ## Two things this deliberately is not
 *
 * It is NOT security. The data is on the wire and in the browser's memory; a
 * devtools tab defeats it in seconds. It defends against a shoulder and a
 * projector, which is the actual threat, and calling it anything more would
 * invite someone to rely on it for something it cannot do. Real confidentiality
 * would have to be enforced server-side, and that is a different feature —
 * arguably the one M3's auth work should build.
 *
 * It is NOT part of the graph. No entity field, no lint rule, no API. It lives
 * in this browser's localStorage, so it cannot reach the agents, the night, or
 * anyone else's Atlas. A viewing preference that could change what the system
 * BELIEVES would be a memory bug wearing a UI hat.
 */

const KEY = 'atlas.private-domains';

/**
 * What a masked name looks like. Fixed width, so it leaks no length.
 *
 * Not a solid redaction bar (`██████` was the first cut): domain labels are
 * bold and tinted, so a filled block drew more eye than any real name on the
 * canvas — the hidden domains became the loudest thing in the picture, which is
 * the opposite of what hiding them is for.
 */
export const MASK = '▪▪▪▪▪';
/** The shorter mask, for a node name inside a cluster. */
export const NODE_MASK = '▪▪▪▪';
export const LOCK = '🔒';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export interface Privacy {
  /** True when this domain — or this `domain/id` — is hidden. */
  isPrivate: (domainOrId: string) => boolean;
  /** The domain's name, or its mask. */
  label: (domain: string) => string;
  /** An entity's short name, or its mask. */
  nodeLabel: (id: string) => string;
  toggle: (domain: string) => void;
  domains: Set<string>;
}

export function usePrivacy(): Privacy {
  const [domains, setDomains] = useState<Set<string>>(load);

  // Two tabs on one screen is a normal way to look at this, and a domain hidden
  // in one while it is named in the other is the failure the feature exists to
  // prevent — so a change in either follows into both.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setDomains(load());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback((domain: string) => {
    setDomains((prev) => {
      const next = new Set(prev);
      if (!next.delete(domain)) next.add(domain);
      localStorage.setItem(KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const isPrivate = useCallback(
    // Ids are path-prefixed (`people/mehdi`), so one predicate answers for both
    // a domain and an entity — which is what lets a cross-reference in someone
    // else's modal mask itself without knowing anything but the id it links to.
    (domainOrId: string) => domains.has(domainOrId.includes('/') ? domainOrId.split('/')[0]! : domainOrId),
    [domains],
  );

  const label = useCallback((domain: string) => (isPrivate(domain) ? `${LOCK} ${MASK}` : domain), [isPrivate]);

  const nodeLabel = useCallback(
    (id: string) => (isPrivate(id) ? NODE_MASK : (id.split('/').pop() ?? id)),
    [isPrivate],
  );

  return { isPrivate, label, nodeLabel, toggle, domains };
}
