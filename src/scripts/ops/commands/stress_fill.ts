// Bulk-seed synthetic roles + rank entries for stress bots (stress:fill / stress:unfill).

import * as path from 'node:path';
import type { OpsCommand } from '../command';
import { confirmDestructive, optNum, optStr, requireNum } from '../command';
import { RankUtil } from '../../../lib/redis_proxy';
import { getOpsConfig } from '../../ops_config';

const DB_NAME = 'dogsvr-example-proj';
const COLL = 'role_coll';
const DEFAULT_RANK_ID = 1;
const DEFAULT_GID_BASE = 8_000_000;
const DEFAULT_COUNT = 10_000;
const DEFAULT_ZONE_ID = 1;

/** Build a deterministic synthetic role document. */
function makeRole(seq: number, zoneId: number, gid: number) {
    return {
        openId: `stress_${seq}`,
        zoneId,
        gid,
        name: `bot_${seq}`,
        score: 0,
    };
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
        throw new Error(`rank config not found: rankId=${rankId}`);
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

/** Reach into private RankUtil.encodeScore — same escape hatch as rank_fill. */
function encodeScore(util: RankUtil, score: number, updateTs: number): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (util as any).encodeScore(score, updateTs);
}

export const stressFill: OpsCommand = {
    name: 'stress:fill',
    summary: 'Seed N synthetic role docs + rank-board entries for stress bots.',
    args: '[--count 10000] [--zone-id 1] [--gid-base 8000000] [--rank-id 1] [--no-rank] [--yes]',
    details: [
        'openId scheme: stress_<seq> for seq in [0, count).',
        'gid range: [gid-base, gid-base + count).',
        'Run "stress:unfill" with the same flags to clean up.',
    ].join('\n'),
    async run(ctx, args) {
        const count = optNum(args, 'count') ?? DEFAULT_COUNT;
        const zoneId = optNum(args, 'zone-id') ?? DEFAULT_ZONE_ID;
        const gidBase = optNum(args, 'gid-base') ?? DEFAULT_GID_BASE;
        const rankId = optNum(args, 'rank-id') ?? DEFAULT_RANK_ID;
        const skipRank = args.flags['no-rank'] !== undefined;
        if (count <= 0) throw new Error('--count must be > 0');

        ctx.log(`target: count=${count} zoneId=${zoneId} gid=[${gidBase}, ${gidBase + count}) rankId=${rankId}${skipRank ? ' (rank skipped)' : ''}`);
        if (!confirmDestructive(args, ctx, `will upsert ${count} roles + ZADD ${count} rank entries`)) return;

        // ---- Mongo upsert in one bulk-write batch (insert if missing). ----
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        const ops = [];
        for (let i = 0; i < count; i++) {
            const role = makeRole(i, zoneId, gidBase + i);
            ops.push({
                updateOne: {
                    filter: { openId: role.openId, zoneId: role.zoneId },
                    update: { $setOnInsert: role },
                    upsert: true,
                },
            });
        }
        const bulkRes = await coll.bulkWrite(ops, { ordered: false });
        ctx.log(`mongo: upserted=${bulkRes.upsertedCount} matched=${bulkRes.matchedCount}`);

        // ---- Redis ZADD baseline so rank queries return non-empty. ----
        if (!skipRank) {
            const util = await loadRankUtil(rankId);
            const now = Math.floor(Date.now() / 1000);
            const members: Array<{ score: number; value: string }> = [];
            for (let i = 0; i < count; i++) {
                const score = i * 10;
                const updateTs = now - (i % 3600);
                const encoded = encodeScore(util, score, updateTs);
                members.push({ score: encoded, value: String(gidBase + i) });
            }
            const key = `rank|${rankId}|allzone`;
            await ctx.redis.zAdd(key, members);
            ctx.log(`redis: zadd=${members.length} key=${key}`);
        }

        ctx.log(`done.`);
    },
};

export const stressUnfill: OpsCommand = {
    name: 'stress:unfill',
    summary: 'Remove synthetic roles + rank entries created by stress:fill.',
    args: '[--count 10000] [--gid-base 8000000] [--rank-id 1] [--yes]',
    async run(ctx, args) {
        const count = optNum(args, 'count') ?? DEFAULT_COUNT;
        const gidBase = optNum(args, 'gid-base') ?? DEFAULT_GID_BASE;
        const rankId = optNum(args, 'rank-id') ?? DEFAULT_RANK_ID;
        if (count <= 0) throw new Error('--count must be > 0');

        ctx.log(`target: gid=[${gidBase}, ${gidBase + count}) rankId=${rankId}`);
        if (!confirmDestructive(args, ctx, `will deleteMany ${count} roles + ZREM ${count} rank entries`)) return;

        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        const gids = Array.from({ length: count }, (_, i) => gidBase + i);
        const delRes = await coll.deleteMany({ gid: { $in: gids } });
        ctx.log(`mongo: deleted=${delRes.deletedCount}`);

        const key = `rank|${rankId}|allzone`;
        const gidStrings = gids.map(String);
        const zremCount = await ctx.redis.zRem(key, gidStrings);
        ctx.log(`redis: zrem=${zremCount} key=${key}`);

        ctx.log('done.');
    },
};

// optStr is imported above; silence "unused" lint.
void optStr;
