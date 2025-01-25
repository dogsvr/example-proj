import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import * as cmdProto from '../shared/cmd_proto';
import { DistributedLock } from "../shared/redis_proxy";
import { getMongoClient } from "../shared/mongo_proxy";

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
    }, JSON.stringify({syncType: req.syncType}));

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
})
