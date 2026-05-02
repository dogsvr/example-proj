import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../shared/cmd_id';
import * as cmdProto from '../shared/cmd_proto';
import { issueTicket } from './session_ticket';

dogsvr.regCmdHandler(cmdId.BATTLE_START_BATTLE, async (reqMsg) => {
    const req: cmdProto.BattleStartBattleReq = JSON.parse(reqMsg.body as string);
    dogsvr.debugLog("BATTLE_START_BATTLE req:", req);

    // zonesvr forwards head.{openId, zoneId, gid}; reject if any is missing
    // so a stray request can never produce a ticket bound to gid=0 and
    // re-introduce the old "rank / push routed to gid=0" bugs.
    const { gid, openId, zoneId } = reqMsg.head;
    if (!gid || !openId || zoneId == null) {
        throw new dogsvr.HandlerError(2001, 'missing gid/openId/zoneId in head');
    }

    const { ticket, ttlMs } = issueTicket({ gid, openId, zoneId });
    const res: cmdProto.BattleStartBattleRes = {
        roomType: req.syncType == "lockstep" ? "lockstep_sync_battle_room" : "state_sync_battle_room",
        battleSvrAddr: "30040",
        ticket,
        ticketTtlMs: ttlMs,
    };
    return JSON.stringify(res);
})
