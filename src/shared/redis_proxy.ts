import { createClient } from '@redis/client';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as crypto from "node:crypto";
import { RankType, type RankT } from 'example-proj-cfg';
import type { RoleInfo } from '../protocols/cmd_proto';

let client: ReturnType<typeof createClient>;

export async function initRedis(url: string) {
    client = createClient({ url: url });
    client.on('error', err => console.log('Redis Client Error', err));
    await client.connect();
    dogsvr.infoLog('redis connected');
}

export function getRedisClient() {
    return client;
}

export class DistributedLock {
    private lockKey: string;
    private lockValue: string;
    private tryNum: number;
    private tryTimeout: number; // milliseconds
    private lockTTL: number; // seconds

    constructor(key: string, tryNum: number = 5, tryTimeout: number = 500, lockTTL: number = 5) {
        this.lockKey = key;
        this.lockValue = this.randomStr();
        this.tryNum = tryNum;
        this.tryTimeout = tryTimeout;
        this.lockTTL = lockTTL;
    }

    async lock() {
        let lock = false;
        for (let i = 0; i < this.tryNum; i++) {
            lock = await this.tryLock();
            if (lock)
                break;
            else if (i + 1 < this.tryNum)
                await new Promise(resolve => setTimeout(resolve, this.tryTimeout));
        }
        return lock;
    }

    async tryLock() {
        let lock = false;
        let res = await client.set(this.lockKey, this.lockValue, { NX: true, EX: this.lockTTL });
        if (res === 'OK') lock = true;
        return lock;
    }

    async unlock() {
        const lua_str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
        let res = await client.eval(lua_str, { keys: [this.lockKey], arguments: [this.lockValue] });
        if (res === 1) return true;
        return false;
    }

    private randomStr() {
        return crypto.randomBytes(64).toString('hex');
    }
}

export enum RankTsAccuracyType {
    HIGH = 1, // activityStartTs + 365 days - submitTs
    LOW = 2   // (rankEndTs - submitTs) / 30
}
export enum RankOrderType {
    DESC = 1,
    ASC = 2,
}
export class RankUtil {
    static readonly HIGH_ACCU_TS_OFFSET = 60 * 60 * 24 * 365;
    static readonly LOW_ACCU_TS_LOST = 30;
    static readonly MAX_SCORE_VALUE = 0xFFFFFFF;
    static readonly MAX_TS_VALUE = 0x1FFFFFF;
    static readonly TS_BIT_NUM = 25; // 25 + 28 = 53
    static readonly SCORE_VALUE_BIT_DISTR = 0x3FFFFFFE000000;
    constructor(
        private tsAccuracyType: number,
        private baseTs: number,
        private scoreAccuracyOffset: number,
        private rankOrder: number,
        private rankCapacity: number,
        private expireTs: number) {
    }
    /**
     * Build a RankUtil + its Redis key from a TbRank config row.
     * Key is composed by `keyBuilder` (defaults to {@link defaultRankKeyBuilder}), which
     * reads role dimension fields based on `row.type` (RankType). Callers that need a
     * different scheme (e.g. seasonal buckets, custom prefix per environment) pass a
     * custom builder.
     */
    static fromCfg(
        row: RankT,
        role: RoleInfo,
        keyBuilder: RankKeyBuilder = defaultRankKeyBuilder,
    ): { util: RankUtil, redisKey: string } {
        const util = new RankUtil(
            row.tsAccuracyType,
            Number(row.baseTs),
            row.scoreAccuracyOffset,
            row.rankOrder,
            row.capacity,
            row.expireTs);
        const redisKey = keyBuilder(row, role);
        return { util, redisKey };
    }
    async updateRank(redisKey: string, gid: number, score: number, updateTs: number) {
        let encodedScore = this.encodeScore(score, updateTs);
        const memberKey = String(gid);
        // zAdd
        let res = await client.zAdd(redisKey, [{ score: encodedScore, value: memberKey }]);
        if (!res) {
            dogsvr.warnLog('updateRank|zAdd failed');
            return;
        }
        // zRemRangeByRank
        await client.zRemRangeByRank(redisKey, 0, -1 - this.rankCapacity);
        // expireAt
        if (this.expireTs > 0) {
            await client.expireAt(redisKey, this.expireTs);
        }
    }
    async querySelfRank(redisKey: string, gid: number): Promise<{ rank: number, score: number, updateTs: number }> {
        const memberKey = String(gid);
        const res = await client.zRevRank(redisKey, memberKey);
        if (res === null) {
            return { rank: 0, score: 0, updateTs: 0 };
        }
        let rank = res + 1;
        const encodedScore = await client.zScore(redisKey, memberKey);
        if (encodedScore === null) {
            return { rank: 0, score: 0, updateTs: 0 };
        }
        const { score, updateTs } = this.decodeScore(encodedScore);
        return { rank: rank, score: score, updateTs: updateTs };
    }
    async queryRank(redisKey: string, offset: number, count: number): Promise<Array<{ gid: number, score: number, updateTs: number }>> {
        let stop_idx = offset + count;
        if (stop_idx > 0) {
            stop_idx -= 1;
        }
        const res = await client.zRangeWithScores(redisKey, offset, stop_idx, { REV: true });
        if (res === null) {
            dogsvr.warnLog('queryRank|zRangeWithScores failed');
            return [];
        }
        let rankList: Array<{ gid: number, score: number, updateTs: number }> = [];
        for (let i = 0; i < res.length; i++) {
            const gid = parseInt(res[i].value);
            const { score, updateTs } = this.decodeScore(res[i].score);
            rankList.push({
                gid: gid,
                score: score,
                updateTs: updateTs
            });
        }
        return rankList;
    }
    private encodeScore(score: number, updateTs: number): number {
        if (this.scoreAccuracyOffset > 1) {
            score = Math.floor(score / this.scoreAccuracyOffset);
        }
        if (score > RankUtil.MAX_SCORE_VALUE || score < 0) {
            dogsvr.warnLog('encodeScore|invalid score|%d', score);
            return 0;
        }
        if (this.tsAccuracyType == RankTsAccuracyType.LOW) {
            updateTs = (this.baseTs - updateTs) / RankUtil.LOW_ACCU_TS_LOST;
        }
        else {
            updateTs = this.baseTs + RankUtil.HIGH_ACCU_TS_OFFSET - updateTs;
        }
        if (updateTs > RankUtil.MAX_TS_VALUE || updateTs < 0) {
            dogsvr.warnLog('encodeScore|invalid updateTs|%d', updateTs);
            return 0;
        }
        if (this.rankOrder == RankOrderType.ASC) {
            score = RankUtil.MAX_SCORE_VALUE - score;
        }
        return ((score & RankUtil.MAX_SCORE_VALUE) << RankUtil.TS_BIT_NUM) | updateTs;
    }
    private decodeScore(encodedScore: number): { score: number, updateTs: number } {
        let score = ((encodedScore & RankUtil.SCORE_VALUE_BIT_DISTR) >> RankUtil.TS_BIT_NUM) & RankUtil.MAX_SCORE_VALUE;
        if (this.rankOrder == RankOrderType.ASC) {
            score = RankUtil.MAX_SCORE_VALUE - score;
        }
        if (this.scoreAccuracyOffset > 1) {
            score = score * this.scoreAccuracyOffset;
        }
        let updateTs = encodedScore & RankUtil.MAX_TS_VALUE;
        if (this.tsAccuracyType == RankTsAccuracyType.LOW) {
            updateTs = this.baseTs - updateTs * RankUtil.LOW_ACCU_TS_LOST;
        }
        else {
            updateTs = this.baseTs + RankUtil.HIGH_ACCU_TS_OFFSET - updateTs;
        }
        return { score: score, updateTs: updateTs };
    }
}

/**
 * Build a Redis key string for a given rank config row and the role whose rank
 * dimension we care about. Passed to {@link RankUtil.fromCfg} when the default
 * scheme does not fit.
 */
export type RankKeyBuilder = (row: RankT, role: RoleInfo) => string;

/**
 * Default key scheme: `rank|{row.id}|{type-tag}[|{dimension}]`.
 *
 * The `type-tag` segment labels the RankType so keys are self-describing and
 * unambiguous under `SCAN MATCH rank|{id}|*`. The optional `{dimension}` segment
 * is the role's corresponding scope id:
 *   - RankType_AllZone:  -> `rank|{id}|allzone`
 *   - RankType_Zone:     -> `rank|{id}|zone|{role.zoneId ?? 0}`
 *   - RankType_City:     -> `rank|{id}|city|{role.cityId ?? 0}`
 *   - RankType_Province: -> `rank|{id}|province|{role.provinceId ?? 0}`
 *
 * Conventions locked in by this builder (extend with care):
 *   1. The `rank|` Redis namespace is reserved for keys produced here; do not
 *      collide from elsewhere in the codebase.
 *   2. Type-tag style is lowercase-compact (`allzone`, not `all_zone` / `AllZone`).
 *      Any new RankType added to rank.xlsx must follow the same style when its
 *      case is added here.
 *   3. Missing role.cityId / role.provinceId falls back to 0. This assumes 0
 *      is NOT a valid city/province id in business data; revisit if that
 *      assumption changes.
 *
 * Throws on unknown RankType so that configuration drift (e.g. a new RankType
 * added to rank.xlsx without updating this builder) surfaces loudly instead of
 * silently bucketing everyone into a stray board.
 */
export const defaultRankKeyBuilder: RankKeyBuilder = (row, role) => {
    const prefix = `rank|${row.id}`;
    switch (row.type) {
        case RankType.RankType_AllZone:
            return `${prefix}|allzone`;
        case RankType.RankType_Zone:
            return `${prefix}|zone|${role.zoneId ?? 0}`;
        case RankType.RankType_City:
            return `${prefix}|city|${role.cityId ?? 0}`;
        case RankType.RankType_Province:
            return `${prefix}|province|${role.provinceId ?? 0}`;
        default:
            throw new Error(
                `defaultRankKeyBuilder: unsupported RankType=${row.type} on rank id=${row.id}. ` +
                `Extend defaultRankKeyBuilder or pass a custom RankKeyBuilder to RankUtil.fromCfg.`
            );
    }
};
