import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../protocols/cmd_id';
import * as cmdProto from '../protocols/cmd_proto';
import { DistributedLock, RankUtil } from "../shared/redis_proxy";
import { getCfgRow, forEachCfgRow } from '@dogsvr/cfg-luban';
import type { RankT } from 'example-proj-cfg';
import { getMongoClient, batchQueryRoleBriefInfo } from "../shared/mongo_proxy";
import { now } from "../shared/time_util";
import { generateGid } from "../shared/gid_util";

dogsvr.regCmdHandler(cmdId.ZONE_LOGIN, async (reqMsg) => {
    const req: cmdProto.ZoneLoginReq = JSON.parse(reqMsg.body as string);
    dogsvr.debugLog("ZONE_LOGIN req:", req);

    // `name` is required: the client composes req.openId as `${deviceId}:${name}`,
    // so a missing / blank name here would produce a trailing-colon openId and
    // a role doc with empty display name. Fail fast instead.
    if (typeof req.name !== 'string' || !req.name.trim()) {
        throw new dogsvr.HandlerError(1005, 'invalid name');
    }

    const lockKey = "rolelock|" + req.openId + "|" + req.zoneId;
    dogsvr.debugLog("lockKey:", lockKey);
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        dogsvr.warnLog("lock failed");
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
            dogsvr.debugLog("register new role:", insertResult);
        }
        else {
            role = findResult[0];
            // Existing-role branch: do NOT overwrite role.name. The openId
            // already encodes the name (openId = `${deviceId}:${name}`), so
            // finding a row here means the same (deviceId, name) pair that
            // originally inserted it; rewriting `name` would be redundant IO.
            // role.score += 1;
            // const updateResult = await collection.updateOne({openId: req.openId, zoneId: req.zoneId}, {$set: {score: role.score}});
            // dogsvr.debugLog("update role:", updateResult);
        }

        const res = { role: role };
        // Patch res head with gid so cl-tsrpc ApiCommon.ts records conn.dogGid
        // on first request. Subsequent requests will then have head.gid
        // auto-filled, and zonesvr->battlesvr routing / rank updates will see
        // the real gid instead of undefined.
        return { body: JSON.stringify(res), head: { gid: role.gid } };
    } finally {
        lockRes = await lock.unlock();
        dogsvr.debugLog("unlockRes:", lockRes);
    }
})

dogsvr.regCmdHandler(cmdId.ZONE_START_BATTLE, async (reqMsg) => {
    const req: cmdProto.ZoneStartBattleReq = JSON.parse(reqMsg.body as string);
    dogsvr.debugLog("ZONE_START_BATTLE req:", req);

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
    dogsvr.debugLog("ZONE_BATTLE_END_NTF:", req);

    const lockKey = "rolelock|" + reqMsg.head.openId + "|" + reqMsg.head.zoneId;
    dogsvr.debugLog("lockKey:", lockKey);
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        dogsvr.warnLog("lock failed");
        return;
    }

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('role_coll');
    const findResult = await collection.find({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, { projection: { _id: 0 } }).toArray();
    if (findResult.length == 0) {
        dogsvr.errorLog(`role not exist|${reqMsg.head.openId}|${reqMsg.head.zoneId}`);
        return;
    }

    const role = findResult[0];
    role.score += req.scoreChange;
    const updateResult = await collection.updateOne({ openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId }, { $set: { score: role.score } });
    dogsvr.debugLog("update role:", updateResult);

    dogsvr.pushMsgByCl("tsrpc", [reqMsg.head.gid ?? 0], {
        cmdId: cmdId.ZONE_BATTLE_END_NTF,
        openId: reqMsg.head.openId,
        zoneId: reqMsg.head.zoneId,
        gid: reqMsg.head.gid
    }, JSON.stringify({ scoreChange: req.scoreChange, role: role }));

    lockRes = await lock.unlock();
    dogsvr.debugLog("unlockRes:", lockRes);

    // Update every configured rank board on battle end.
    // Extending rank.xlsx with a new row requires no handler code change.
    const updatePromises: Promise<void>[] = [];
    const updateTs = now();
    const gid = reqMsg.head.gid ?? 0;
    forEachCfgRow<RankT>('TbRank', (row) => {
        const { util, redisKey } = RankUtil.fromCfg(row, role as unknown as cmdProto.RoleInfo);
        updatePromises.push(util.updateRank(redisKey, gid, role.score, updateTs));
    });
    await Promise.all(updatePromises);
    // Return an empty body so the worker replies to main_thread. The sender
    // uses callCmdByClc(..., noResponse=true) which is understood only inside
    // its own worker — once the message crosses the gRPC wire and reaches the
    // peer's main_thread, that main_thread always opens a txn in
    // sendMsgToWorkerThread and waits for a reply (5s TxnMgr default).
    // Returning undefined here is a silent-drop on our side but manifests as
    // `txn timeout|txnId:N|timeoutMs:5000` on zonesvr main 5 seconds later.
    // An empty reply is harmless: the sender discarded the response anyway.
    return '';
})

dogsvr.regCmdHandler(cmdId.ZONE_QUERY_RANK_LIST, async (reqMsg) => {
    const req: cmdProto.ZoneQueryRankListReq = JSON.parse(reqMsg.body as string);
    dogsvr.debugLog("ZONE_QUERY_RANK_LIST req:", req);

    const rankRow = getCfgRow<RankT>('TbRank', req.rankId);
    if (!rankRow) {
        throw new dogsvr.HandlerError(1003, `rank cfg not found: rankId=${req.rankId}`);
    }
    // Look up the requester's role to pick the right rank-dimension value (zone/city/province).
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
