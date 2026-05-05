/**
 * Commands for the `zone_coll` collection — the authoritative list of zones
 * returned to clients via DIR_QUERY_ZONE_LIST.
 *
 * Schema (see src/protocols/cmd_proto.ts ZoneInfo):
 *   { zoneId: number, name: string, address: string, mergeTo: number }
 *
 * `zoneId` is the logical primary key. zone_coll has no indexes today, so
 * queries are full scans — fine for the small cardinality we expect.
 */

import type { OpsCommand } from '../command';
import { confirmDestructive, hasFlag, optNum, optStr, requireNum } from '../command';

const DB_NAME = 'dogsvr-example-proj';
const COLL = 'zone_coll';

export const zoneList: OpsCommand = {
    name: 'zone:list',
    summary: 'List every zone in zone_coll.',
    async run(ctx) {
        const docs = await ctx.mongo.db(DB_NAME).collection(COLL)
            .find({}, { projection: { _id: 0 } })
            .sort({ zoneId: 1 })
            .toArray();
        if (docs.length === 0) {
            ctx.log('(no zones)');
            return;
        }
        console.table(docs);
        ctx.log(`${docs.length} zone(s).`);
    },
};

export const zoneAdd: OpsCommand = {
    name: 'zone:add',
    summary: 'Upsert a zone (create or replace). Idempotent.',
    args: '--zone-id <n> [--name <s>] [--address <s>] [--merge-to <n>]',
    details: [
        'Fields other than --zone-id default to the empty string / 0 on a first',
        'insert, matching ZoneInfo defaults. Running twice with different --name',
        'values overwrites the previous record.',
    ].join('\n'),
    async run(ctx, args) {
        const zoneId = requireNum(args, 'zone-id');
        const name = optStr(args, 'name') ?? '';
        const address = optStr(args, 'address') ?? '';
        const mergeTo = optNum(args, 'merge-to') ?? 0;
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        const res = await coll.updateOne(
            { zoneId },
            { $set: { zoneId, name, address, mergeTo } },
            { upsert: true },
        );
        ctx.log(`zone upserted: zoneId=${zoneId} name="${name}" address="${address}" mergeTo=${mergeTo}`);
        ctx.log(`matched=${res.matchedCount} modified=${res.modifiedCount} upsertedId=${res.upsertedId ?? '(none)'}`);
    },
};

export const zoneRemove: OpsCommand = {
    name: 'zone:remove',
    summary: 'Delete one zone by zoneId. Dry-run without --yes.',
    args: '--zone-id <n> [--yes]',
    async run(ctx, args) {
        const zoneId = requireNum(args, 'zone-id');
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        const doc = await coll.findOne({ zoneId }, { projection: { _id: 0 } });
        if (!doc) {
            ctx.log(`no zone with zoneId=${zoneId}; nothing to do.`);
            return;
        }
        ctx.log('target:', doc);
        if (!confirmDestructive(args, ctx, `will delete zone_coll doc zoneId=${zoneId}`)) return;
        const res = await coll.deleteOne({ zoneId });
        ctx.log(`deleted: count=${res.deletedCount}`);
        // If the user also wants to scrub role docs for the zone, they can
        // follow up with role:list --zone-id <n> and role:remove per-gid.
        if (!hasFlag(args, 'yes')) return;
    },
};
