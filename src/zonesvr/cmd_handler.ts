import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../protocols/cmd_id';
import * as cmdProto from '../protocols/cmd_proto';
import { DistributedLock, RankUtil } from "../shared/redis_proxy";
import { getCfgRow, forEachCfgRow } from '@dogsvr/cfg-luban';
import type { RankT } from 'example-proj-cfg';
import { getMongoClient, batchQueryRoleBriefInfo } from "../shared/mongo_proxy";
import { now, nowMs } from "../shared/time_util";
import { generateGid } from "../shared/gid_util";

const log = dogsvr.log.child({ module: 'zonesvr/cmd_handler' });

dogsvr.regCmdHandler(cmdId.ZONE_LOGIN, async (reqMsg) => {
    const req: cmdProto.ZoneLoginReq = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "ZONE_LOGIN req");

    // `name` is required: the client composes req.openId as `${deviceId}:${name}`,
    // so a missing / blank name here would produce a trailing-colon openId and
    // a role doc with empty display name. Fail fast instead.
    if (typeof req.name !== 'string' || !req.name.trim()) {
        throw new dogsvr.HandlerError(1005, 'invalid name');
    }

    const lockKey = "rolelock|" + req.openId + "|" + req.zoneId;
    log.debug({ lockKey }, "acquiring lock");
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        log.warn({ lockKey }, "lock failed");
        return;   // silent drop
    }

    try {
        const db = getMongoClient().db("dogsvr-example-proj");
        const collection = db.collection('role_coll');
        const findResult = await collection.find({ openId: req.openId, zoneId: req.zoneId }, { projection: { _id: 0 } }).toArray();
        let role = null;
        if (findResult.length == 0) {
            // register new role
            const gid = await generateGid(req.openId, req.zoneId);
            if (gid < 0) {
                throw new dogsvr.HandlerError(1001, 'generateGid failed');
            }
            role = { openId: req.openId, zoneId: req.zoneId, gid: gid, name: req.name, score: 0 };
            const insertResult = await collection.insertOne(role);
            log.debug({ insertResult }, "register new role");
        }
        else {
            role = findResult[0];
            // openId already encodes the name, so same (deviceId, name) → same row; no rewrite.
            // role.score += 1;
            // const updateResult = await collection.updateOne({openId: req.openId, zoneId: req.zoneId}, {$set: {score: role.score}});
            // log.debug({ updateResult }, "update role");
        }

        const res = { role: role };
        // Stamp gid on head so cl-tsrpc records conn.dogGid for subsequent requests.
        return { body: JSON.stringify(res), head: { gid: role.gid } };
    } finally {
        lockRes = await lock.unlock();
        log.debug({ unlockRes: lockRes }, "unlocked");
    }
})

dogsvr.regCmdHandler(cmdId.ZONE_START_BATTLE, async (reqMsg) => {
    const req: cmdProto.ZoneStartBattleReq = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "ZONE_START_BATTLE req");

    let battleRes = await dogsvr.callCmdByClc("battlesvr", {
        cmdId: cmdId.BATTLE_START_BATTLE,
        openId: reqMsg.head.openId,
        zoneId: reqMsg.head.zoneId,
        gid: reqMsg.head.gid
    }, JSON.stringify({ syncType: req.syncType }));

    if (battleRes == null) {
        throw new dogsvr.HandlerError(1002, 'call battlesvr timeout');
    }
    return battleRes as string;
})

dogsvr.regCmdHandler(cmdId.ZONE_BATTLE_END_NTF, async (reqMsg) => {
    const req: cmdProto.ZoneBattleEndNtf = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "ZONE_BATTLE_END_NTF");

    // No-op when score is unchanged. Empty string keeps the txn-reply contract
    // (see end-of-handler comment).
    if (!req.scoreChange) return '';

    const lockKey = "rolelock|" + reqMsg.head.openId + "|" + reqMsg.head.zoneId;
    log.debug({ lockKey }, "acquiring lock");
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        log.warn({ lockKey }, "lock failed");
        return;
    }

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('role_coll');
    const findResult = await collection.find({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, { projection: { _id: 0 } }).toArray();
    if (findResult.length == 0) {
        log.error({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, "role not exist");
        return;
    }

    const role = findResult[0];
    role.score += req.scoreChange;
    const updateResult = await collection.updateOne({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, { $set: { score: role.score } });
    log.debug({ updateResult }, "update role");

    dogsvr.pushMsgByCl("tsrpc", [reqMsg.head.gid ?? 0], {
        cmdId: cmdId.ZONE_BATTLE_END_NTF,
        openId: reqMsg.head.openId,
        zoneId: reqMsg.head.zoneId,
        gid: reqMsg.head.gid
    }, JSON.stringify({ scoreChange: req.scoreChange, role: role }));

    lockRes = await lock.unlock();
    log.debug({ unlockRes: lockRes }, "unlocked");

    // Update every configured rank board on battle end.
    // Adding a row to rank.xlsx requires no handler code change.
    const updatePromises: Promise<void>[] = [];
    const updateTs = now();
    const gid = reqMsg.head.gid ?? 0;
    forEachCfgRow<RankT>('TbRank', (row) => {
        const { util, redisKey } = RankUtil.fromCfg(row, role as unknown as cmdProto.RoleInfo);
        updatePromises.push(util.updateRank(redisKey, gid, role.score, updateTs));
    });
    await Promise.all(updatePromises);
    // Must return a body even though the caller used noResponse=true.
    // The gRPC hop from battlesvr → zonesvr main_thread always opens a txn
    // in sendMsgToWorkerThread; returning undefined causes a txn timeout.
    return '';
})

dogsvr.regCmdHandler(cmdId.ZONE_QUERY_RANK_LIST, async (reqMsg) => {
    const req: cmdProto.ZoneQueryRankListReq = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "ZONE_QUERY_RANK_LIST req");

    const rankRow = getCfgRow<RankT>('TbRank', req.rankId);
    if (!rankRow) {
        throw new dogsvr.HandlerError(1003, `rank cfg not found: rankId=${req.rankId}`);
    }
    // Look up the requester's role to pick the right rank-dimension value.
    const db = getMongoClient().db("dogsvr-example-proj");
    const roleColl = db.collection('role_coll');
    const roleFound = await roleColl.find({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, { projection: { _id: 0 } }).toArray();
    if (roleFound.length == 0) {
        throw new dogsvr.HandlerError(1004, `role not found: openId=${reqMsg.head.openId} zoneId=${reqMsg.head.zoneId}`);
    }
    const selfRole = roleFound[0] as unknown as cmdProto.RoleInfo;
    const { util: rankUtil, redisKey } = RankUtil.fromCfg(rankRow, selfRole);
    const selfRank = await rankUtil.querySelfRank(redisKey, reqMsg.head.gid ?? 0);
    const rankList = await rankUtil.queryRank(redisKey, req.offset, req.count);
    const gidList = rankList.map(r => r.gid);
    const roleBriefMap = await batchQueryRoleBriefInfo(gidList);

    const res: cmdProto.ZoneQueryRankListRes = {
        selfRank: { score: selfRank.score, updateTs: selfRank.updateTs, rank: selfRank.rank },
        rankList: []
    };
    for (let i = 0; i < rankList.length; ++i) {
        res.rankList.push({
            roleBriefInfo: roleBriefMap.get(rankList[i].gid) ?? { gid: rankList[i].gid, name: "" },
            score: rankList[i].score,
            updateTs: rankList[i].updateTs,
            rank: i + 1
        });
    }
    return JSON.stringify(res);
})

dogsvr.regCmdHandler(cmdId.ZONE_HEARTBEAT, async (reqMsg) => {
    const req: cmdProto.ZoneHeartbeatReq = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "ZONE_HEARTBEAT req");
    const res: cmdProto.ZoneHeartbeatRes = { serverTs: nowMs() };
    return JSON.stringify(res);
})
