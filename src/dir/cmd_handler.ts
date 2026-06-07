import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../protocols/cmd_id';
import * as cmdProto from '../protocols/cmd_proto';
import { getMongoClient } from "../shared/mongo_proxy";

const log = dogsvr.log.child({ module: 'dir/cmd_handler' });

dogsvr.regCmdHandler(cmdId.DIR_QUERY_ZONE_LIST, async (reqMsg) => {
    const req: cmdProto.DirQueryZoneListReq = JSON.parse(reqMsg.body as string);
    log.debug({ req }, "DIR_QUERY_ZONE_LIST req");

    const db = getMongoClient().db("dogsvr-example-proj");
    const collection = db.collection('zone_coll');
    const findResult = await collection.find({}, { projection: { _id: 0 } }).toArray();

    const res = { zoneList: findResult };
    return JSON.stringify(res);
})
