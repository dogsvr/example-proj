import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import * as cmdProto from '../shared/cmd_proto';
import { getMongoClient } from "../shared/mongo_proxy";

dogsvr.regCmdHandler(cmdId.DIR_QUERY_ZONE_LIST, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.DirQueryZoneListReq = JSON.parse(innerReq as string);
    dogsvr.debugLog("DIR_QUERY_ZONE_LIST req:", req);

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('zone_coll');
    const findResult = await collection.find({}, { projection: { _id: 0 } }).toArray();

    const res = { zoneList: findResult };
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
