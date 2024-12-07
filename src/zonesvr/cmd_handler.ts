import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import { DistributedLock } from "../shared/redis_proxy";
import { getMongoClient } from "../shared/mongo_proxy";

dogsvr.regCmdHandler(cmdId.DIR_QUERY_ZONE_LIST, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('zonelist');
    const findResult = await collection.find({}, {projection: { _id: 0}}).toArray();

    const res = {zonelist: findResult};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})

dogsvr.regCmdHandler(cmdId.ZONE_LOGIN, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    const lockKey = "rolelock|" + req.openid + "|" + req.zoneid;
    dogsvr.debugLog("lockKey:", lockKey);
    const lock = new DistributedLock(lockKey);
    let lockRes = await lock.lock();
    if (!lockRes) {
        dogsvr.warnLog("lock failed");
        return;
    }

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('zone_role_coll');
    const findResult = await collection.find({openid: req.openid, zoneid: req.zoneid}, {projection: { _id: 0}}).toArray();
    let role = null;
    if (findResult.length == 0) {
        // register new role
        role = { openid: req.openid, zoneid: req.zoneid, name: req.name, score: 0 };
        const insertResult = await collection.insertOne(role);
        dogsvr.debugLog("register new role:", insertResult);
    }
    else
    {
        role = findResult[0];
        role.score += 1;
        const updateResult = await collection.updateOne({openid: req.openid, zoneid: req.zoneid}, {$set: {score: role.score}});
        dogsvr.debugLog("update role:", updateResult);
    }

    const res = {role: role};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));

    lockRes = await lock.unlock();
    dogsvr.debugLog("unlockRes:", lockRes);
})

dogsvr.regCmdHandler(cmdId.ZONE_START_BATTLE, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    let battleRes = await dogsvr.callCmdByClc("battlesvr", cmdId.BATTLE_START_BATTLE, JSON.stringify({req: "zonesvr req"}));

    const res = {res: JSON.parse(battleRes as string)};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})

dogsvr.regCmdHandler(cmdId.ZONE_BATTLE_END_NTF, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    const res = {res: ""};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
