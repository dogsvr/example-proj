import { getMongoClient } from './mongo_proxy';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

/**
 * GID (Global ID) is a globally unique numeric identifier for a role,
 * generated from openId and zoneId.
 *
 * Default encoding: gid = zoneId * GID_ZONE_MULTIPLIER + autoIncrementSeq
 * e.g. zoneId=3, seq=42 => gid = 3_000_000_042
 * The zoneId is directly visible from the gid value.
 *
 * Upper bound
 * -----------
 * gid is carried as a JS `number` end-to-end: MsgHeadType.gid, MongoDB
 * role_coll.gid (BSON double), TSRPC JSON on the wire, cl-grpc wire
 * (uint64, but the ts-proto binding uses `forceLong=number`), Colyseus
 * schema `@type("number")`, and the client-side Phaser registry. The
 * global cap is therefore Number.MAX_SAFE_INTEGER = 2^53 - 1 ≈ 9.007e15.
 *
 * Combined with the default encoding, the hard upper bound on zoneId is:
 *     zoneId <= floor(MAX_SAFE_INTEGER / GID_ZONE_MULTIPLIER) ≈ 9_007_199
 * i.e. ~9 million zones, well above any realistic deployment.
 *
 * Exceeding this bound requires either shrinking GID_ZONE_MULTIPLIER
 * (which reduces per-zone seq headroom) or migrating the entire stack to
 * bigint — MsgHeadType.gid, the cl-grpc proto binding (forceLong=bigint),
 * the JSON codec, and the Colyseus schema all have to change together.
 * That migration is intentionally not supported out of the box.
 */

export const GID_ZONE_MULTIPLIER = 1_000_000_000; // 1 billion

/** GID generator function signature — can be overridden by business code */
export type GidGeneratorFn = (openId: string, zoneId: number) => Promise<number>;

let customGenerator: GidGeneratorFn | null = null;

/**
 * Override the default GID generator with a custom implementation.
 */
export function setGidGenerator(gen: GidGeneratorFn): void {
    customGenerator = gen;
}

/**
 * Generate a GID. Uses custom generator if set, otherwise the default implementation.
 */
export async function generateGid(openId: string, zoneId: number): Promise<number> {
    if (customGenerator) {
        return customGenerator(openId, zoneId);
    }
    return defaultGenerateGid(openId, zoneId);
}

/**
 * Default GID generator using MongoDB atomic counter.
 * Counter collection: dogsvr-example-proj.gid_counter
 * Document: { _id: "zone_{zoneId}", seq: N }
 * Result: zoneId * GID_ZONE_MULTIPLIER + seq
 */
async function defaultGenerateGid(openId: string, zoneId: number): Promise<number> {
    const db = getMongoClient().db("dogsvr-example-proj");
    const counterColl = db.collection('gid_counter');
    const result = await counterColl.findOneAndUpdate(
        { _id: `zone_${zoneId}` as any },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    if (!result || !result.seq) {
        dogsvr.errorLog('generateGid failed|zoneId=%d|openId=%s', zoneId, openId);
        return -1;
    }
    const gid = zoneId * GID_ZONE_MULTIPLIER + (result.seq as number);
    return gid;
}

/**
 * Extract zoneId from a GID value.
 */
export function getZoneIdFromGid(gid: number): number {
    return Math.floor(gid / GID_ZONE_MULTIPLIER);
}
