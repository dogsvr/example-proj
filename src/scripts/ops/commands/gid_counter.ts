/**
 * Peek at the GID auto-increment counter.
 *
 * Counter doc shape (see src/shared/gid_util.ts):
 *   { _id: "zone_<zoneId>", seq: <number> }
 * in collection `dogsvr-example-proj.gid_counter`.
 *
 * We expose a read-only command: mutating the counter by hand is a foot-gun
 * (risk of gid collisions with previously-issued roles). If you need to
 * reset it in dev, drop the collection with `mongosh` deliberately.
 */

import type { OpsCommand } from '../command';
import { optNum } from '../command';

const DB_NAME = 'dogsvr-example-proj';
const COLL = 'gid_counter';

export const gidCounterPeek: OpsCommand = {
    name: 'gid-counter:peek',
    summary: 'Show the current seq for one zone or every zone.',
    args: '[--zone-id <n>]',
    async run(ctx, args) {
        const zoneId = optNum(args, 'zone-id');
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        if (zoneId !== undefined) {
            const doc = await coll.findOne({ _id: `zone_${zoneId}` as unknown as never });
            if (!doc) {
                ctx.log(`(no counter yet for zone ${zoneId})`);
                return;
            }
            ctx.log(doc);
            return;
        }
        const docs = await coll.find({}).sort({ _id: 1 }).toArray();
        if (docs.length === 0) {
            ctx.log('(no counters yet — no role has logged in)');
            return;
        }
        console.table(docs.map((d) => ({ _id: d._id, seq: d.seq })));
    },
};
