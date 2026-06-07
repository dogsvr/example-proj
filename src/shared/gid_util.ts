import { getMongoClient } from './mongo_proxy';
import { log as rootLog } from '@dogsvr/dogsvr/worker_thread';

const log = rootLog.child({ module: 'shared/gid_util' });

/**
 * GID (Global ID) encodes zoneId + per-zone auto-increment sequence.
 * Default: gid = zoneId * GID_ZONE_MULTIPLIER + seq
 *
 * gid is a JS `number` end-to-end (MsgHeadType, MongoDB, TSRPC, gRPC, Colyseus schema,
 * client Phaser registry), so the ceiling is Number.MAX_SAFE_INTEGER = 2^53 - 1.
 * With GID_ZONE_MULTIPLIER = 1e9 this allows ~9 million zones.
 */

export const GID_ZONE_MULTIPLIER = 1_000_000_000; // 1 billion

/** GID generator function — can be overridden by business code via setGidGenerator. */
export type GidGeneratorFn = (openId: string, zoneId: number) => Promise<number>;

let customGenerator: GidGeneratorFn | null = null;

/**
 * Override the default GID generator.
 */
export function setGidGenerator(gen: GidGeneratorFn): void {
    customGenerator = gen;
}

/** Generate a GID; uses custom generator if set. */
export async function generateGid(openId: string, zoneId: number): Promise<number> {
    if (customGenerator) {
        return customGenerator(openId, zoneId);
    }
    return defaultGenerateGid(openId, zoneId);
}

/**
 * Default GID generator: MongoDB atomic counter per zone.
 * Doc: { _id: "zone_{zoneId}", seq: N } → gid = zoneId * GID_ZONE_MULTIPLIER + seq
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
        log.error({ zoneId, openId }, 'generateGid failed');
        return -1;
    }
    const gid = zoneId * GID_ZONE_MULTIPLIER + (result.seq as number);
    return gid;
}

/** Extract zoneId from a GID. */
export function getZoneIdFromGid(gid: number): number {
    return Math.floor(gid / GID_ZONE_MULTIPLIER);
}
