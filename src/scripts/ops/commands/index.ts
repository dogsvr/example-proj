/**
 * Registry of every ops command. Adding a new one is:
 *   1. drop a file under commands/ exporting `const fooBar: OpsCommand`
 *   2. add one import + one entry to the `commands` array below
 *
 * The dispatcher (ops.ts) just walks this array by `name`. No other wiring
 * is required — no plugin loader, no config, no `require()` scan. A plain
 * array keeps tree-shaking obvious and lets TS flag typos immediately.
 *
 * Ordering here controls the order shown by `help`. Keep it grouped by
 * resource (zone → role → rank → lock → gid-counter → stats → raw → help).
 */

import type { OpsCommand } from '../command';

import { zoneList, zoneAdd, zoneRemove } from './zone';
import { roleList, roleGet, roleRemove } from './role';
import { rankList, rankTop, rankClear, rankClearAll } from './rank';
import { rankFill, rankUnfill } from './rank_fill';
import { lockList, lockRelease } from './lock';
import { gidCounterPeek } from './gid_counter';
import { stats } from './stats';
import { redisScan, redisGet, redisDel } from './redis_raw';
import { mongoCount } from './mongo_raw';
import { help } from './help';

export const commands: OpsCommand[] = [
    zoneList, zoneAdd, zoneRemove,
    roleList, roleGet, roleRemove,
    rankList, rankTop, rankClear, rankClearAll,
    rankFill, rankUnfill,
    lockList, lockRelease,
    gidCounterPeek,
    stats,
    redisScan, redisGet, redisDel,
    mongoCount,
    help,
];
