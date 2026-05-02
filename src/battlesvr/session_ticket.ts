// Session ticket store used by battlesvr to bind a BATTLE_START_BATTLE response
// to a subsequent Colyseus `joinOrCreate` call. Tickets are single-use and expire
// after TICKET_TTL_MS. The store is an in-process Map and is only safe to use
// from a single worker thread (battlesvr currently runs with workerThreadNum=1).
import { randomUUID } from 'node:crypto';

export type TicketPayload = {
    gid: number;
    openId: string;
    zoneId: number;
};

type TicketEntry = TicketPayload & {
    ticket: string;
    expiresAt: number;
    timer: NodeJS.Timeout;
};

export const TICKET_TTL_MS = 30_000;

const store = new Map<string, TicketEntry>();

export function issueTicket(p: TicketPayload): { ticket: string; ttlMs: number } {
    const ticket = randomUUID();
    const timer = setTimeout(() => store.delete(ticket), TICKET_TTL_MS);
    // do not keep the event loop alive just because of a pending ticket timer
    timer.unref?.();
    store.set(ticket, {
        ticket,
        expiresAt: Date.now() + TICKET_TTL_MS,
        timer,
        ...p,
    });
    return { ticket, ttlMs: TICKET_TTL_MS };
}

export function consumeTicket(ticket: string | undefined | null): TicketPayload | null {
    if (!ticket) return null;
    const entry = store.get(ticket);
    if (!entry) return null;
    // single-use: delete before returning so a replay cannot hit the same entry
    clearTimeout(entry.timer);
    store.delete(ticket);
    if (entry.expiresAt < Date.now()) return null;
    return { gid: entry.gid, openId: entry.openId, zoneId: entry.zoneId };
}
