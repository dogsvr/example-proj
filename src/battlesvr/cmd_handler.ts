import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';

dogsvr.regCmdHandler(cmdId.BATTLE_START_BATTLE, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);
    dogsvr.debugLog(req);

    const res = {res: "battlesvr res"};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
