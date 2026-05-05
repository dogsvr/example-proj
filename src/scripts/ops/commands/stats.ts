/**
 * High-level summary across Mongo + Redis — the "is this deployment alive and
 * roughly healthy?" sanity check.
 */

import type { OpsCommand, RedisClient } from '../command';

const DB_NAME = 'dogsvr-example-proj';

async function countKeys(redis: RedisClient, pattern: string): Promise<number> {
    let n = 0;
    let cursor = '0';
    do {
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 500 });
        cursor = String(reply.cursor);
        n += reply.keys.length;
    } while (cursor !== '0');
    return n;
}

export const stats: OpsCommand = {
    name: 'stats',
    summary: 'Print counts across Mongo and Redis in one go.',
    async run(ctx) {
        const db = ctx.mongo.db(DB_NAME);
        const [zones, roles, counters, rankKeys, lockKeys] = await Promise.all([
            db.collection('zone_coll').countDocuments(),
            db.collection('role_coll').countDocuments(),
            db.collection('gid_counter').countDocuments(),
            countKeys(ctx.redis, 'rank|*'),
            countKeys(ctx.redis, 'rolelock|*'),
        ]);
        console.table([
            { scope: 'mongo', name: 'zone_coll',   count: zones },
            { scope: 'mongo', name: 'role_coll',   count: roles },
            { scope: 'mongo', name: 'gid_counter', count: counters },
            { scope: 'redis', name: 'rank|*',      count: rankKeys },
            { scope: 'redis', name: 'rolelock|*',  count: lockKeys },
        ]);
    },
};
