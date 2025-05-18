import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import * as cmdProto from '../shared/cmd_proto';
import { DistributedLock, RankUtil, RankTsAccuracyType, RankOrderType } from "../shared/redis_proxy";
import { getMongoClient } from "../shared/mongo_proxy";
import { now } from "../shared/time_util";

dogsvr.regCmdHandler(cmdId.ZONE_LOGIN, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.ZoneLoginReq = JSON.parse(innerReq as string);
    dogsvr.debugLog("ZONE_LOGIN req:", req);

    const lockKey = "rolelock|" + req.openId + "|" + req.zoneId;
    dogsvr.debugLog("lockKey:", lockKey);
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        dogsvr.warnLog("lock failed");
        return;
    }

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('role_coll');
    const findResult = await collection.find({ openId: req.openId, zoneId: req.zoneId }, { projection: { _id: 0 } }).toArray();
    let role = null;
    if (findResult.length == 0) {
        // register new role
        role = { openId: req.openId, zoneId: req.zoneId, name: "", score: 0 };
        const insertResult = await collection.insertOne(role);
        dogsvr.debugLog("register new role:", insertResult);
    }
    else {
        role = findResult[0];
        // role.score += 1;
        // const updateResult = await collection.updateOne({openId: req.openId, zoneId: req.zoneId}, {$set: {score: role.score}});
        // dogsvr.debugLog("update role:", updateResult);
    }

    const res = { role: role };
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));

    lockRes = await lock.unlock();
    dogsvr.debugLog("unlockRes:", lockRes);
})

dogsvr.regCmdHandler(cmdId.ZONE_START_BATTLE, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.ZoneStartBattleReq = JSON.parse(innerReq as string);
    dogsvr.debugLog("ZONE_START_BATTLE req:", req);

    let battleRes = await dogsvr.callCmdByClc("battlesvr", {
        cmdId: cmdId.BATTLE_START_BATTLE,
        openId: reqMsg.head.openId,
        zoneId: reqMsg.head.zoneId
    }, JSON.stringify({ syncType: req.syncType }));

    const res = battleRes;
    // dogsvr.respondCmd(reqMsg, JSON.stringify(res));
    dogsvr.respondCmd(reqMsg, res as string);
})

dogsvr.regCmdHandler(cmdId.ZONE_BATTLE_END_NTF, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.ZoneBattleEndNtf = JSON.parse(innerReq as string);
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

    dogsvr.pushMsgByCl("tsrpc", [reqMsg.head.openId + "|" + reqMsg.head.zoneId], {
        cmdId: cmdId.ZONE_BATTLE_END_NTF,
        openId: reqMsg.head.openId,
        zoneId: reqMsg.head.zoneId
    }, JSON.stringify({ scoreChange: req.scoreChange, role: role }));

    lockRes = await lock.unlock();
    dogsvr.debugLog("unlockRes:", lockRes);

    let rankUtil = new RankUtil(
        RankTsAccuracyType.LOW,
        Date.parse("2050-01-01 00:00:00") / 1000,
        1,
        RankOrderType.DESC,
        100,
        0);
    await rankUtil.updateRank(
        "battleScoreRank|province|0",
        { openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId },
        role.score,
        now()
    );
})

dogsvr.regCmdHandler(cmdId.ZONE_QUERY_RANK_LIST, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.ZoneQueryRankListReq = JSON.parse(innerReq as string);
    dogsvr.debugLog("ZONE_QUERY_RANK_LIST req:", req);

    let rankUtil = new RankUtil(
        RankTsAccuracyType.LOW,
        Date.parse("2050-01-01 00:00:00") / 1000,
        1,
        RankOrderType.DESC,
        100,
        0);
    let selfRank = await rankUtil.querySelfRank("battleScoreRank|province|0",
        { openId: reqMsg.head.openId, zoneId: reqMsg.head.zoneId });
    const rankList = await rankUtil.queryRank("battleScoreRank|province|0", req.offset, req.count);
    // TODO: batch query RoleBriefInfo from mongo

    const res: cmdProto.ZoneQueryRankListRes = {
        selfRank: { score: selfRank.score, updateTs: selfRank.updateTs, rank: selfRank.rank },
        rankList: []
    };
    for (let i = 0; i < rankList.length; ++i) {
        res.rankList.push({
            roleBriefInfo: { roleId: rankList[i].roleId, name: "" },
            score: rankList[i].score,
            updateTs: rankList[i].updateTs,
            rank: i + 1
        });
    }
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
