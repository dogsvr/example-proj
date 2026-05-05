/**
 * Raw Redis escape hatch for things the high-level commands don't cover.
 * Intentionally small — the goal is "give me a safe, readable REDIS-CLI",
 * not to reimplement redis-cli.
 */

import type { OpsCommand, RedisClient } from '../command';
import { confirmDestructive, optNum, optStr } from '../command';

async function scanKeys(redis: RedisClient, pattern: string, count: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count });
        cursor = String(reply.cursor);
        for (const k of reply.keys) keys.push(k);
    } while (cursor !== '0');
    return keys;
}

export const redisScan: OpsCommand = {
    name: 'redis:scan',
    summary: 'Non-blocking SCAN for keys matching a pattern.',
    args: '--match <glob> [--count 100]',
    async run(ctx, args) {
        const match = optStr(args, 'match') ?? '*';
        const count = optNum(args, 'count') ?? 100;
        const keys = await scanKeys(ctx.redis, match, count);
        if (keys.length === 0) {
            ctx.log(`(no keys match "${match}")`);
            return;
        }
        keys.sort();
        for (const k of keys) ctx.log(k);
        ctx.log(`(${keys.length} key(s) match "${match}")`);
    },
};

export const redisGet: OpsCommand = {
    name: 'redis:get',
    summary: 'Fetch one key. Output adapts to the key\'s type.',
    args: '<key>',
    async run(ctx, args) {
        const key = args.positional[0];
        if (!key) throw new Error('usage: redis:get <key>');
        const type = await ctx.redis.type(key);
        ctx.log(`type=${type}`);
        switch (type) {
            case 'none':
                ctx.log('(no such key)');
                return;
            case 'string': {
                const v = await ctx.redis.get(key);
                const ttl = await ctx.redis.ttl(key);
                ctx.log(`ttl=${ttl}`);
                ctx.log(v);
                return;
            }
            case 'hash': {
                const h = await ctx.redis.hGetAll(key);
                console.table(h);
                return;
            }
            case 'zset': {
                // Full dump can be huge; cap at 50 to avoid flooding the terminal.
                const all = await ctx.redis.zRangeWithScores(key, 0, 49, { REV: true });
                console.table(all);
                const total = await ctx.redis.zCard(key);
                if (total > 50) ctx.log(`(showing top 50 of ${total})`);
                return;
            }
            case 'set': {
                const members = await ctx.redis.sMembers(key);
                for (const m of members) ctx.log(m);
                ctx.log(`(${members.length} member(s))`);
                return;
            }
            case 'list': {
                const items = await ctx.redis.lRange(key, 0, 99);
                for (const it of items) ctx.log(it);
                const len = await ctx.redis.lLen(key);
                ctx.log(`(${items.length} of ${len} item(s) shown)`);
                return;
            }
            default:
                ctx.log(`(type "${type}" not supported by redis:get; use redis-cli)`);
        }
    },
};

export const redisDel: OpsCommand = {
    name: 'redis:del',
    summary: 'Delete one key (any type). Dry-run without --yes.',
    args: '<key> [--yes]',
    async run(ctx, args) {
        const key = args.positional[0];
        if (!key) throw new Error('usage: redis:del <key> [--yes]');
        const exists = await ctx.redis.exists(key);
        if (!exists) {
            ctx.log(`(no such key) ${key}`);
            return;
        }
        const type = await ctx.redis.type(key);
        ctx.log(`target: ${key} (type=${type})`);
        if (!confirmDestructive(args, ctx, `will DEL ${key}`)) return;
        const n = await ctx.redis.del(key);
        ctx.log(`deleted: count=${n}`);
    },
};
