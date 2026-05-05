/**
 * Commands for the `role_coll` collection — one document per logged-in player.
 *
 * Schema (see src/protocols/cmd_proto.ts RoleInfo):
 *   { openId, zoneId, gid, name, score, cityId?, provinceId? }
 *
 * Indexes (ensured at zonesvr startup, see src/shared/mongo_proxy.ts):
 *   - { openId: 1, zoneId: 1 }  // login / update PK
 *   - { gid: 1 }                // rank-list join target
 *
 * `role:get` accepts either an (openId, zoneId) pair or a gid; both paths hit
 * an index.
 */

import type { OpsCommand } from '../command';
import { confirmDestructive, optNum, optStr, requireNum, requireStr } from '../command';

const DB_NAME = 'dogsvr-example-proj';
const COLL = 'role_coll';

export const roleList: OpsCommand = {
    name: 'role:list',
    summary: 'List roles. Optionally filter by zone and cap the row count.',
    args: '[--zone-id <n>] [--limit <n>]',
    async run(ctx, args) {
        const zoneId = optNum(args, 'zone-id');
        const limit = optNum(args, 'limit') ?? 50;
        const filter: Record<string, unknown> = zoneId !== undefined ? { zoneId } : {};
        const docs = await ctx.mongo.db(DB_NAME).collection(COLL)
            .find(filter, { projection: { _id: 0 } })
            .sort({ zoneId: 1, gid: 1 })
            .limit(limit)
            .toArray();
        if (docs.length === 0) {
            ctx.log('(no roles match)');
            return;
        }
        console.table(docs);
        ctx.log(`shown ${docs.length} row(s) (limit=${limit}${zoneId !== undefined ? `, zoneId=${zoneId}` : ''}).`);
    },
};

export const roleGet: OpsCommand = {
    name: 'role:get',
    summary: 'Fetch a single role by (openId, zoneId) or by gid.',
    args: '--open-id <s> --zone-id <n>  |  --gid <n>',
    async run(ctx, args) {
        const gid = optNum(args, 'gid');
        const openId = optStr(args, 'open-id');
        const zoneId = optNum(args, 'zone-id');
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        let filter: Record<string, unknown>;
        if (gid !== undefined) {
            filter = { gid };
        } else if (openId !== undefined && zoneId !== undefined) {
            filter = { openId, zoneId };
        } else {
            throw new Error('role:get requires --gid <n> or (--open-id <s> --zone-id <n>)');
        }
        const doc = await coll.findOne(filter, { projection: { _id: 0 } });
        if (!doc) {
            ctx.log('(not found)');
            return;
        }
        ctx.log(doc);
    },
};

export const roleRemove: OpsCommand = {
    name: 'role:remove',
    summary: 'Delete a single role by gid. Dry-run without --yes.',
    args: '--gid <n> [--yes]',
    details: [
        'Leaves rank ZSETs untouched — stale rank entries only disappear when',
        'trimmed by rank capacity or cleared via rank:clear*. That is intentional:',
        "we don't want role:remove to silently mutate an unrelated data structure.",
    ].join('\n'),
    async run(ctx, args) {
        const gid = requireNum(args, 'gid');
        const coll = ctx.mongo.db(DB_NAME).collection(COLL);
        const doc = await coll.findOne({ gid }, { projection: { _id: 0 } });
        if (!doc) {
            ctx.log(`no role with gid=${gid}; nothing to do.`);
            return;
        }
        ctx.log('target:', doc);
        if (!confirmDestructive(args, ctx, `will delete role_coll doc gid=${gid}`)) return;
        const res = await coll.deleteOne({ gid });
        ctx.log(`deleted: count=${res.deletedCount}`);
    },
};
