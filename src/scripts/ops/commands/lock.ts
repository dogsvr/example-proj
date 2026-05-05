/**
 * Distributed-lock inspection and release.
 *
 * Locks use keys `rolelock|<openId>|<zoneId>` (see src/shared/redis_proxy.ts
 * DistributedLock). They have a 5-second TTL so normal operation self-heals;
 * lock:release is for pathological cases where a server crashed mid-section.
 */

import type { OpsCommand, RedisClient } from '../command';
import { confirmDestructive, requireStr } from '../command';

async function scanKeys(redis: RedisClient, pattern: string, count = 200): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count });
        cursor = String(reply.cursor);
        for (const k of reply.keys) keys.push(k);
    } while (cursor !== '0');
    return keys;
}

export const lockList: OpsCommand = {
    name: 'lock:list',
    summary: 'List live role locks with remaining TTL.',
    async run(ctx) {
        const keys = await scanKeys(ctx.redis, 'rolelock|*');
        if (keys.length === 0) {
            ctx.log('(no locks held)');
            return;
        }
        const rows: Array<{ key: string; ttl: number; owner: string }> = [];
        for (const k of keys) {
            const ttl = await ctx.redis.ttl(k);
            const owner = (await ctx.redis.get(k)) ?? '(gone)';
            rows.push({ key: k, ttl, owner });
        }
        console.table(rows);
        ctx.log(`${keys.length} lock(s). Each lock self-expires within ~5s of acquisition.`);
    },
};

export const lockRelease: OpsCommand = {
    name: 'lock:release',
    summary: 'Force-release a lock by full key. Dry-run without --yes.',
    args: '--key <rolelock|openId|zoneId> [--yes]',
    details: [
        'Normally you should not need this — locks expire after 5 seconds. Use',
        'only when a server crashed holding the lock AND the TTL has somehow',
        "not elapsed (clock skew, very long request). Releasing someone else's",
        'active lock is a correctness hazard; prefer waiting out the TTL.',
    ].join('\n'),
    async run(ctx, args) {
        const key = requireStr(args, 'key');
        if (!key.startsWith('rolelock|')) {
            throw new Error(`refusing: --key must start with "rolelock|", got "${key}"`);
        }
        const exists = await ctx.redis.exists(key);
        if (!exists) {
            ctx.log(`(no such key) ${key}`);
            return;
        }
        const ttl = await ctx.redis.ttl(key);
        const owner = await ctx.redis.get(key);
        ctx.log(`target: key=${key} ttl=${ttl}s owner=${owner}`);
        if (!confirmDestructive(args, ctx, `will DEL ${key}`)) return;
        const n = await ctx.redis.del(key);
        ctx.log(`deleted: count=${n}`);
    },
};
