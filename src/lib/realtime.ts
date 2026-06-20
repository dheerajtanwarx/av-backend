import { Response } from "express";

/* In-process SSE hub for the admin notification center.
   Single-instance by design (matches the current one-process Render deploy):
   connections live in this module's memory and publish() writes to them
   directly. To scale to multiple instances, keep addClient/removeClient as-is
   and route publish() through Redis pub/sub (every instance subscribes and
   relays to its local clients) — no caller has to change. */

export type RealtimeEventName =
  | "notification:new"
  | "notification:read"
  | "notification:unread"
  | "notification:archived"
  | "notification:unarchived"
  | "notification:read_all"
  | "notification:read_bulk"
  | "notification:archived_bulk"
  | "notification:unarchived_bulk"
  | "activity:new"
  | "dashboard:update"
  // Live analytics: a compact per-visitor event for the activity feed, and a
  // periodic aggregated metrics snapshot for the live dashboard counters.
  | "analytics:event"
  | "analytics:metrics";

export interface RealtimeEvent {
  event: RealtimeEventName;
  data: unknown;
  /** SSE event id. Set only for notification:new (the notification id), so
      the browser's Last-Event-ID points at the newest delivered notification
      and reconnects can replay exactly what was missed. */
  id?: number;
  /** Deliver only to these admin user ids; omit to broadcast to everyone. */
  userIds?: number[];
}

interface Client {
  userId: number;
  res: Response;
  connectedAt: number;
  /** ms epoch when the auth token presented at connect time expires; the
      heartbeat closes the stream then, forcing a reconnect that re-runs
      requireAdmin. Null = no expiry claim on the token. */
  expiresAt: number | null;
}

const clients = new Set<Client>();

/** Cap streams per admin so an abandoned tab farm can't leak sockets — the
    oldest connection is closed when a new one would exceed the cap. */
const MAX_STREAMS_PER_USER = 5;

/** Keep-alive comment interval. Render's proxy kills idle connections around
    the minute mark; 25s keeps the stream warm without meaningful traffic. */
const HEARTBEAT_MS = 25_000;

export function writeEvent(res: Response, e: RealtimeEvent): void {
  if (e.id != null) res.write(`id: ${e.id}\n`);
  res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

export function addClient(
  userId: number,
  res: Response,
  expiresAt: number | null = null
): Client {
  const mine = [...clients]
    .filter((c) => c.userId === userId)
    .sort((a, b) => a.connectedAt - b.connectedAt);
  while (mine.length >= MAX_STREAMS_PER_USER) {
    const oldest = mine.shift()!;
    try {
      oldest.res.end();
    } catch {
      /* already gone */
    }
    clients.delete(oldest);
  }
  const client: Client = { userId, res, connectedAt: Date.now(), expiresAt };
  clients.add(client);
  return client;
}

/** Distinct user ids with at least one open stream (for periodic re-auth). */
export function connectedUserIds(): number[] {
  return [...new Set([...clients].map((c) => c.userId))];
}

/** Close every stream belonging to these users — used when a periodic
    re-check finds a connected user is no longer an admin. The client's
    EventSource will reconnect and be rejected by requireAdmin. */
export function dropUsers(userIds: number[]): void {
  if (userIds.length === 0) return;
  const drop = new Set(userIds);
  for (const c of clients) {
    if (!drop.has(c.userId)) continue;
    try {
      c.res.end();
    } catch {
      /* already gone */
    }
    clients.delete(c);
  }
}

export function removeClient(client: Client): void {
  clients.delete(client);
}

/** Push one event to every matching open stream. A dead socket is dropped on
    write failure; the client's EventSource will reconnect on its own. */
export function publish(e: RealtimeEvent): void {
  for (const c of clients) {
    if (e.userIds && !e.userIds.includes(c.userId)) continue;
    try {
      writeEvent(c.res, e);
    } catch {
      clients.delete(c);
    }
  }
}

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    // A stream must not outlive the credentials that opened it.
    if (c.expiresAt != null && now >= c.expiresAt) {
      try {
        c.res.end();
      } catch {
        /* already gone */
      }
      clients.delete(c);
      continue;
    }
    try {
      c.res.write(`: ping ${now}\n\n`);
    } catch {
      clients.delete(c);
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref(); // never keep the process alive just for pings
