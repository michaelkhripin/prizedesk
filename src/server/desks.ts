import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Store } from '../desk/store.js';

/**
 * Where each request's desk state lives. Locally there is one shared desk on
 * disk; in the hosted demo every visitor gets a private in-memory desk, so
 * judges never see or change each other's runs.
 */
export interface Desks {
  forRequest(req: Request, res: Response): Store;
  all(): Store[];
}

export function sharedDesk(store: Store): Desks {
  return { forRequest: () => store, all: () => [store] };
}

const COOKIE = 'pd_visitor';

export function perVisitorDesks(maxVisitors = 300, ttlMs = 24 * 3600_000): Desks {
  const desks = new Map<string, { store: Store; seen: number }>();
  const evict = () => {
    const now = Date.now();
    for (const [id, d] of desks) if (now - d.seen > ttlMs) desks.delete(id);
    while (desks.size > maxVisitors) desks.delete(desks.keys().next().value!);
  };
  return {
    forRequest(req, res) {
      let id = req.headers.cookie?.match(new RegExp(`${COOKIE}=([\\w-]+)`))?.[1];
      if (!id || !desks.has(id)) {
        id ??= randomUUID();
        desks.set(id, { store: new Store(null), seen: Date.now() });
        res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: ttlMs });
        evict();
      }
      const d = desks.get(id)!;
      d.seen = Date.now();
      // Re-insert so Map order tracks recency for eviction.
      desks.delete(id);
      desks.set(id, d);
      return d.store;
    },
    all: () => [...desks.values()].map((d) => d.store),
  };
}

/** Fixed-window limiter per visitor and route group. */
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.headers.cookie?.match(/pd_visitor=([\w-]+)/)?.[1] ?? req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > limit) {
      res.status(429).json({ error: `Demo limit reached: try again in ${Math.ceil((h.reset - now) / 60000)} min.` });
      return;
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}
