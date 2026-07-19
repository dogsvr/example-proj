import { createClient } from '@redis/client';
import { log as rootLog } from '@dogsvr/dogsvr/worker_thread';
import * as crypto from "node:crypto";
import { RankType, type RankT } from 'example-proj-cfg';
import type { RoleInfo } from '../protocols/cmd_proto';
import { timeRedisOp } from '../otel/metrics_worker';

const log = rootLog.child({ module: 'redis_proxy' });

let rawClient: ReturnType<typeof createClient>;
let client: ReturnType<typeof createClient>;

function buildTimedClient(raw: ReturnType<typeof createClient>): ReturnType<typeof createClient> {
    return new Proxy(raw, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (typeof orig !== 'function' || typeof prop !== 'string') return orig;
            return (...args: unknown[]) => {
                const ret = (orig as (...a: unknown[]) => unknown).apply(target, args);
                if (ret instanceof Promise) {
                    return timeRedisOp(prop, () => ret as Promise<unknown>);
                }
                return ret;
            };
        },
    }) as ReturnType<typeof createClient>;
}

export async function initRedis(url: string) {
    rawClient = createClient({ url: url });
    rawClient.on('error', err => console.log('Redis Client Error', err));
    await rawClient.connect();
    client = buildTimedClient(rawClient);
    log.info('redis connected');
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
        const res = await client.set(this.lockKey, this.lockValue, { NX: true, EX: this.lockTTL });
        return res === 'OK';
    }

    async unlock() {
        const lua_str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
        const res = await client.eval(lua_str, { keys: [this.lockKey], arguments: [this.lockValue] });
        return res === 1;
    }

    private randomStr() {
        return crypto.randomBytes(64).toString('hex');
    }
}

export enum RankTsAccuracyType {
    HIGH = 1, // activityStartTs + 365 days - submitTs
    LOW = 2   // (rankEndTs - submitTs) / 30 (30s buckets)
}
export enum RankOrderType {
    DESC = 1,
    ASC = 2,
}
export class RankUtil {
    static readonly HIGH_ACCU_TS_OFFSET = 60 * 60 * 24 * 365;
    static readonly LOW_ACCU_TS_LOST = 30;
    static readonly MAX_SCORE_VALUE = 0xFFFFFFF; // 28-bit score field
    static readonly MAX_TS_VALUE = 0x1FFFFFF;    // 25-bit ts field
    // Layout: [score:28bit][ts:25bit] packed into a 53-bit safe integer.
    // Uses arithmetic (not `<<`/`|`) because JS bitwise ops truncate to int32.
    static readonly TS_SHIFT = 0x2000000; // 2 ** 25
    constructor(
        private tsAccuracyType: number,
        private baseTs: number,
        private scoreAccuracyOffset: number,
        private rankOrder: number,
        private rankCapacity: number,
        private expireTs: number) {
    }
    /**
     * Build a RankUtil + Redis key from a TbRank config row.
     * Pass a custom keyBuilder when the default scheme doesn't fit.
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
        const encodedScore = this.encodeScore(score, updateTs);
        const memberKey = String(gid);
        await client.zAdd(redisKey, [{ score: encodedScore, value: memberKey }]);
        await client.zRemRangeByRank(redisKey, 0, -1 - this.rankCapacity);
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
        return { rank, score, updateTs };
    }
    async queryRank(redisKey: string, offset: number, count: number): Promise<Array<{ gid: number, score: number, updateTs: number }>> {
        let stop_idx = offset + count;
        if (stop_idx > 0) {
            stop_idx -= 1;
        }
        const res = await client.zRangeWithScores(redisKey, offset, stop_idx, { REV: true });
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
            log.warn({ score }, 'encodeScore: invalid score');
            return 0;
        }
        if (this.tsAccuracyType == RankTsAccuracyType.LOW) {
            updateTs = Math.floor((this.baseTs - updateTs) / RankUtil.LOW_ACCU_TS_LOST);
        }
        else {
            updateTs = Math.floor(this.baseTs + RankUtil.HIGH_ACCU_TS_OFFSET - updateTs);
        }
        if (updateTs > RankUtil.MAX_TS_VALUE || updateTs < 0) {
            log.warn({ updateTs }, 'encodeScore: invalid updateTs');
            return 0;
        }
        if (this.rankOrder == RankOrderType.ASC) {
            score = RankUtil.MAX_SCORE_VALUE - score;
        }
        // Arithmetic pack: (score * 2^25) + ts. Fits 53-bit safe integer.
        return score * RankUtil.TS_SHIFT + updateTs;
    }
    private decodeScore(encodedScore: number): { score: number, updateTs: number } {
        let updateTs = encodedScore % RankUtil.TS_SHIFT;
        let score = Math.floor(encodedScore / RankUtil.TS_SHIFT);
        if (this.rankOrder == RankOrderType.ASC) {
            score = RankUtil.MAX_SCORE_VALUE - score;
        }
        if (this.scoreAccuracyOffset > 1) {
            score = score * this.scoreAccuracyOffset;
        }
        if (this.tsAccuracyType == RankTsAccuracyType.LOW) {
            updateTs = this.baseTs - updateTs * RankUtil.LOW_ACCU_TS_LOST;
        }
        else {
            updateTs = this.baseTs + RankUtil.HIGH_ACCU_TS_OFFSET - updateTs;
        }
        return { score, updateTs };
    }
}

/** Build a Redis key for a rank config row and role. Passed to RankUtil.fromCfg. */
export type RankKeyBuilder = (row: RankT, role: RoleInfo) => string;

/**
 * Default key scheme: `rank|{row.id}|{type-tag}[|{dimension}]`
 * Throws on unknown RankType.
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
