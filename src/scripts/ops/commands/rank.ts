/**
 * Rank-board commands (Redis ZSET keys `rank|<rankId>|<dim>...`).
 *
 * The rank system's score encoding is non-obvious: each ZSET score is a
 * 53-bit packed value = (gameScore << 25) | tsField. Reading with plain
 * ZREVRANGE WITHSCORES therefore shows a useless large integer. For the
 * `rank:top` command we reconstruct the rank config row via cfg-luban and
 * use {@link RankUtil} to decode; for list / clear we only need the key
 * pattern, so cfg-luban is not initialised.
 */

import * as path from 'node:path';
import type { OpsCommand, OpsContext, ParsedArgs, RedisClient } from '../command';
import { confirmDestructive, hasFlag, optNum, optStr, promptYesNo, requireNum } from '../command';
import { RankUtil } from '../../../shared/redis_proxy';
import { getOpsConfig } from '../../ops_config';

/**
 * Scan all keys matching `pattern` using non-blocking SCAN (not KEYS).
 *
 * On a large production Redis, KEYS blocks the server for the duration of the
 * match — unacceptable when ops tools are used alongside live traffic. SCAN
 * returns cursors so we can iterate incrementally without holding the event
 * loop. We still collect into an array for printing / deletion, but with the
 * assumption that `rank|*` has bounded cardinality (one per rank-id × dim).
 */
async function scanKeys(redis: RedisClient, pattern: string, count = 200): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        // @redis/client v5 returns { cursor, keys } for scan.
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count });
        cursor = String(reply.cursor);
        for (const k of reply.keys) keys.push(k);
    } while (cursor !== '0');
    return keys;
}

/**
 * Parse the `--dim` flag into a Redis key suffix.
 *
 *   allzone        -> "allzone"
 *   zone:42        -> "zone|42"
 *   city:7         -> "city|7"
 *   province:12    -> "province|12"
 *
 * Returns the full Redis key `rank|<rankId>|<suffix>` or throws on bad input.
 */
function dimToKey(rankId: number, dim: string): string {
    if (dim === 'allzone') return `rank|${rankId}|allzone`;
    const m = /^(zone|city|province):(-?\d+)$/.exec(dim);
    if (!m) {
        throw new Error(`invalid --dim "${dim}"; expected "allzone" or "zone:N" | "city:N" | "province:N"`);
    }
    return `rank|${rankId}|${m[1]}|${m[2]}`;
}

export const rankList: OpsCommand = {
    name: 'rank:list',
    summary: 'List every rank board key with its cardinality (ZCARD) and TTL.',
    async run(ctx) {
        const keys = await scanKeys(ctx.redis, 'rank|*');
        if (keys.length === 0) {
            ctx.log('(no rank keys)');
            return;
        }
        keys.sort();
        const rows: Array<{ key: string; size: number; ttl: number }> = [];
        for (const k of keys) {
            const size = await ctx.redis.zCard(k);
            const ttl = await ctx.redis.ttl(k);
            rows.push({ key: k, size, ttl });
        }
        console.table(rows);
        ctx.log(`${keys.length} rank key(s). TTL: -1 = no expiry, -2 = already gone.`);
    },
};

export const rankTop: OpsCommand = {
    name: 'rank:top',
    summary: 'Show the top N members of a rank board, with decoded score and updateTs.',
    args: '--rank-id <n> --dim <allzone|zone:N|city:N|province:N> [--count 10]',
    details: [
        'Decoding requires the TbRank config row, which is why this command loads',
        'cfg-luban. rank:list / rank:clear do not decode, so they skip the cfg open.',
    ].join('\n'),
    async run(ctx, args) {
        const rankId = requireNum(args, 'rank-id');
        const dim = optStr(args, 'dim') ?? 'allzone';
        const count = optNum(args, 'count') ?? 10;
        const key = dimToKey(rankId, dim);

        // Lazy cfg-luban init: only rank:top needs to decode scores.
        // We reuse the zonesvr config's paths (cfgDbPath / tableKeysPath).
        const { openCfgDb, getCfgRow } = await import('@dogsvr/cfg-luban');
        const cfgModule = await import('example-proj-cfg');
        const cfg = getOpsConfig();
        openCfgDb({
            dbPath: path.resolve(cfg._configDir, cfg.cfgDbPath ?? '../../../example-proj-cfg/dist/db'),
            tableKeysPath: path.resolve(cfg._configDir, cfg.tableKeysPath ?? '../../../example-proj-cfg/dist/table_keys.json'),
            cfgModule,
        });
        const row = getCfgRow<import('example-proj-cfg').RankT>('TbRank', rankId);
        if (!row) {
            throw new Error(`rank config not found: rankId=${rankId} (check example-proj-cfg rank.xlsx)`);
        }
        // We only need RankUtil's decoder; construct directly (not fromCfg,
        // which expects a RoleInfo purely to build the key — the key is
        // already known here).
        const util = new RankUtil(
            row.tsAccuracyType,
            Number(row.baseTs),
            row.scoreAccuracyOffset,
            row.rankOrder,
            row.capacity,
            row.expireTs,
        );
        const raw = await ctx.redis.zRangeWithScores(key, 0, Math.max(0, count - 1), { REV: true });
        if (raw.length === 0) {
            ctx.log(`(empty) key=${key}`);
            return;
        }
        // RankUtil.decodeScore is private; re-encode the same logic here by
        // round-tripping through queryRank-style decoding. Simpler: use a
        // lightweight inline decoder mirroring decodeScore exactly.
        const rows = raw.map((entry: { value: string; score: number }, i: number) => {
            const decoded = decodeWithRankUtil(util, entry.score);
            return {
                rank: i + 1,
                gid: entry.value,
                score: decoded.score,
                updateTs: new Date(decoded.updateTs * 1000).toISOString(),
            };
        });
        ctx.log(`key=${key}  count=${raw.length}`);
        console.table(rows);
    },
};

/**
 * Decode an encoded ZSET score by leaning on {@link RankUtil} without touching
 * its private `decodeScore`. We re-implement the same arithmetic here; kept
 * identical to redis_proxy.ts so any future change there should be mirrored
 * (guarded by the test that rank:top returns sensible values).
 */
function decodeWithRankUtil(util: RankUtil, encoded: number): { score: number; updateTs: number } {
    // Access the private-ish state via the same constant arithmetic used in
    // redis_proxy.ts. We keep the branches in sync on purpose.
    const TS_SHIFT = RankUtil.TS_SHIFT;
    const LOW = 2;
    const ASC = 2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = util as any;
    let updateTs = encoded % TS_SHIFT;
    let score = Math.floor(encoded / TS_SHIFT);
    if (u.rankOrder === ASC) score = RankUtil.MAX_SCORE_VALUE - score;
    if (u.scoreAccuracyOffset > 1) score = score * u.scoreAccuracyOffset;
    if (u.tsAccuracyType === LOW) {
        updateTs = u.baseTs - updateTs * RankUtil.LOW_ACCU_TS_LOST;
    } else {
        updateTs = u.baseTs + RankUtil.HIGH_ACCU_TS_OFFSET - updateTs;
    }
    return { score, updateTs };
}

export const rankClear: OpsCommand = {
    name: 'rank:clear',
    summary: 'Clear one rank board (one dim) or every dim under a given --rank-id.',
    args: '--rank-id <n> [--dim <allzone|zone:N|city:N|province:N>] [--yes]',
    details: [
        'Without --dim, SCANs rank|<rank-id>|* and deletes every match — useful',
        'when a season reset should wipe all zone/city/province splits of one',
        'board without touching other boards.',
    ].join('\n'),
    async run(ctx, args) {
        const rankId = requireNum(args, 'rank-id');
        const dim = optStr(args, 'dim');
        let keys: string[];
        if (dim) {
            const key = dimToKey(rankId, dim);
            const exists = await ctx.redis.exists(key);
            if (!exists) {
                ctx.log(`(no such key) ${key}`);
                return;
            }
            keys = [key];
        } else {
            keys = await scanKeys(ctx.redis, `rank|${rankId}|*`);
            if (keys.length === 0) {
                ctx.log(`(no rank keys for rank-id=${rankId})`);
                return;
            }
        }
        ctx.log(`targets (${keys.length}):`);
        for (const k of keys) ctx.log(`  ${k}`);
        if (!confirmDestructive(args, ctx, `will DEL ${keys.length} rank key(s)`)) return;
        let n = 0;
        for (const k of keys) n += await ctx.redis.del(k);
        ctx.log(`deleted: count=${n}`);
    },
};

export const rankClearAll: OpsCommand = {
    name: 'rank:clear-all',
    summary: 'Clear EVERY rank key in Redis. Most destructive rank op.',
    args: '--yes --i-know-this-nukes-all-ranks',
    details: [
        'Requires both --yes and the long acknowledgement flag, AND answers',
        '"yes" to an interactive prompt. No single fat-finger can trigger it.',
    ].join('\n'),
    async run(ctx: OpsContext, args: ParsedArgs) {
        const keys = await scanKeys(ctx.redis, 'rank|*');
        if (keys.length === 0) {
            ctx.log('(no rank keys exist — nothing to do)');
            return;
        }
        ctx.log(`would delete ${keys.length} rank key(s):`);
        for (const k of keys.slice(0, 20)) ctx.log(`  ${k}`);
        if (keys.length > 20) ctx.log(`  ... and ${keys.length - 20} more`);
        if (!hasFlag(args, 'yes')) {
            ctx.log('[dry-run] pass --yes to proceed.');
            return;
        }
        if (!hasFlag(args, 'i-know-this-nukes-all-ranks')) {
            ctx.log('[dry-run] refusing without --i-know-this-nukes-all-ranks.');
            return;
        }
        const go = await promptYesNo(`Type "yes" to wipe all ${keys.length} rank keys`);
        if (!go) {
            ctx.log('aborted.');
            return;
        }
        let n = 0;
        for (const k of keys) n += await ctx.redis.del(k);
        ctx.log(`deleted: count=${n}`);
    },
};
