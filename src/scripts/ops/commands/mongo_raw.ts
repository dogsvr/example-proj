/**
 * Minimal Mongo escape hatch. Count-with-filter is the one raw operation that
 * came up repeatedly in design discussion — everything else (list / get / edit)
 * is better served by the typed zone / role / gid-counter commands or by
 * `mongosh` when you genuinely need ad-hoc queries.
 */

import type { OpsCommand } from '../command';
import { optStr } from '../command';

const DB_NAME = 'dogsvr-example-proj';

export const mongoCount: OpsCommand = {
    name: 'mongo:count',
    summary: 'Run countDocuments on a collection with an optional JSON filter.',
    args: '<collection> [--filter <json>]',
    details: [
        'Example: mongo:count role_coll --filter \'{"zoneId":100001}\'',
        'The filter must parse as JSON — single-quoted strings / unquoted keys',
        'will fail. For complex ad-hoc queries use mongosh.',
    ].join('\n'),
    async run(ctx, args) {
        const coll = args.positional[0];
        if (!coll) throw new Error('usage: mongo:count <collection> [--filter <json>]');
        const filterStr = optStr(args, 'filter') ?? '{}';
        let filter: Record<string, unknown>;
        try {
            filter = JSON.parse(filterStr);
        } catch (e) {
            throw new Error(`--filter must be valid JSON: ${(e as Error).message}`);
        }
        const n = await ctx.mongo.db(DB_NAME).collection(coll).countDocuments(filter);
        ctx.log(`${DB_NAME}.${coll}: ${n} doc(s) match ${JSON.stringify(filter)}`);
    },
};
