import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmd from './cmd';

dogsvr.regCmdHandler(cmd.ZONE_QUERY_PROP_PACKAGE, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    const res = {res: ""};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
