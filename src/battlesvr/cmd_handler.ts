import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import * as cmdProto from '../shared/cmd_proto';

dogsvr.regCmdHandler(cmdId.BATTLE_START_BATTLE, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req: cmdProto.BattleStartBattleReq = JSON.parse(innerReq as string);
    dogsvr.debugLog("BATTLE_START_BATTLE req:", req);

    const res: cmdProto.BattleStartBattleRes = {
        roomType: req.syncType == "lockstep" ? "lockstep_sync_battle_room" : "state_sync_battle_room",
        battleSvrAddr: "2567"
    };
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
