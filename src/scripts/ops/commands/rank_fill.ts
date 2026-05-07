import * as path from 'node:path';
import type { OpsCommand, RedisClient } from '../command';
import { confirmDestructive, hasFlag, optNum, optStr, requireNum } from '../command';
import { RankUtil } from '../../../shared/redis_proxy';
import { getOpsConfig } from '../../ops_config';

/** SCAN keys matching `pattern` — see rank.ts for the KEYS-vs-SCAN rationale. */
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

/** Parse `--dim` into the Redis key suffix. Mirrors rank.ts#dimToKey. */
function dimToKey(rankId: number, dim: string): string {
    if (dim === 'allzone') return `rank|${rankId}|allzone`;
    const m = /^(zone|city|province):(-?\d+)$/.exec(dim);
    if (!m) {
        throw new Error(`invalid --dim "${dim}"; expected "allzone" or "zone:N" | "city:N" | "province:N"`);
    }
    return `rank|${rankId}|${m[1]}|${m[2]}`;
}

async function loadRankUtil(rankId: number): Promise<RankUtil> {
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
    return new RankUtil(
        row.tsAccuracyType,
        Number(row.baseTs),
        row.scoreAccuracyOffset,
        row.rankOrder,
        row.capacity,
        row.expireTs,
    );
}

/** Reach into private RankUtil.encodeScore — ops-only escape hatch. */
function encodeScore(util: RankUtil, score: number, updateTs: number): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (util as any).encodeScore(score, updateTs);
}

export const rankFill: OpsCommand = {
    name: 'rank:fill',
    summary: 'Fill a rank board with N synthetic ZSET entries for client perf testing.',
    args: '--rank-id <n> [--dim <...>] [--count 50] [--gid-base 9000000] [--score-min 100] [--score-max 10000] [--yes]',
    details: [
        'Redis only — no Mongo role doc, so the client shows "(anon)" names.',
        'gid range: [gid-base, gid-base + count). Default base 9_000_000',
        'stays clear of real gids. Re-run with same base to overwrite.',
        'Use rank:unfill to clean up.',
    ].join('\n'),
    async run(ctx, args) {
        const rankId = requireNum(args, 'rank-id');
        const dim = optStr(args, 'dim') ?? 'allzone';
        const count = optNum(args, 'count') ?? 50;
        const gidBase = optNum(args, 'gid-base') ?? 9_000_000;
        const scoreMin = optNum(args, 'score-min') ?? 100;
        const scoreMax = optNum(args, 'score-max') ?? 10_000;

        if (count <= 0) throw new Error('--count must be > 0');
        if (scoreMax < scoreMin) throw new Error('--score-max must be >= --score-min');

        const key = dimToKey(rankId, dim);
        ctx.log(`target: key=${key} count=${count} gid=[${gidBase}, ${gidBase + count})`);
        if (!confirmDestructive(args, ctx, `will ZADD ${count} entries to ${key}`)) return;

        const util = await loadRankUtil(rankId);
        const now = Math.floor(Date.now() / 1000);

        // Scores spread min→max; updateTs staggered across the last 24h.
        const members: Array<{ score: number; value: string }> = [];
        for (let i = 0; i < count; i++) {
            const gid = gidBase + i;
            const score = scoreMin + Math.floor(((scoreMax - scoreMin) * i) / Math.max(1, count - 1));
            const updateTs = now - Math.floor((i * 86400) / Math.max(1, count - 1));
            const encoded = encodeScore(util, score, updateTs);
            if (encoded === 0 && score !== 0) {
                throw new Error(`encodeScore returned 0 for bot #${i} (score=${score}, updateTs=${updateTs}) — check MAX_SCORE_VALUE / MAX_TS_VALUE`);
            }
            members.push({ score: encoded, value: String(gid) });
        }
        // Batch ZADD: one round-trip.
        await ctx.redis.zAdd(key, members);

        ctx.log(`done: zadd=${members.length}`);
        ctx.log(`tip: "rank:unfill --rank-id ${rankId} --gid-base ${gidBase} --count ${count}" to clean up`);
    },
};

export const rankUnfill: OpsCommand = {
    name: 'rank:unfill',
    summary: 'Remove synthetic entries added by rank:fill (by gid range).',
    args: '--rank-id <n> [--dim <...>] [--gid-base 9000000] [--count 50] [--all-dims] [--yes]',
    details: [
        'ZREM the gid range. Redis only. With --all-dims, scans every dim of',
        'this rank-id and ZREMs from each matching key.',
    ].join('\n'),
    async run(ctx, args) {
        const rankId = requireNum(args, 'rank-id');
        const dim = optStr(args, 'dim') ?? 'allzone';
        const gidBase = optNum(args, 'gid-base') ?? 9_000_000;
        const count = optNum(args, 'count') ?? 50;
        const allDims = hasFlag(args, 'all-dims');
        if (count <= 0) throw new Error('--count must be > 0');

        const gidStrings = Array.from({ length: count }, (_, i) => String(gidBase + i));

        const keys = allDims
            ? await scanKeys(ctx.redis, `rank|${rankId}|*`)
            : [dimToKey(rankId, dim)];

        ctx.log(`will ZREM ${gidStrings.length} member(s) from ${keys.length} key(s):`);
        for (const k of keys) ctx.log(`  ${k}`);
        if (!confirmDestructive(args, ctx, `ZREM gid=[${gidBase}, ${gidBase + count})`)) return;

        let zremTotal = 0;
        for (const k of keys) {
            const n = await ctx.redis.zRem(k, gidStrings);
            zremTotal += typeof n === 'number' ? n : 0;
        }
        ctx.log(`done: zrem=${zremTotal}`);
    },
};
