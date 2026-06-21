/**
 * Registry of ops commands. To add a new command:
 *   1. Export an OpsCommand from a file under commands/
 *   2. Import it here and add to the array below
 */

import type { OpsCommand } from '../command';

import { zoneList, zoneAdd, zoneRemove } from './zone';
import { roleList, roleGet, roleRemove } from './role';
import { rankList, rankTop, rankClear, rankClearAll } from './rank';
import { rankFill, rankUnfill } from './rank_fill';
import { stressFill, stressUnfill } from './stress_fill';
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
    stressFill, stressUnfill,
    lockList, lockRelease,
    gidCounterPeek,
    stats,
    redisScan, redisGet, redisDel,
    mongoCount,
    help,
];
