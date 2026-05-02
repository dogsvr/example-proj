import { Room, Client, ServerError } from "colyseus";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../shared/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';

type Action = {
  vkey: any;
  args: any;
  playerId: any;
};

class Frame {
  frameId: number = 0;
  actions: Action[] = [];
};

export class LockstepSyncBattleRoom extends Room {
  frameArray: Frame[] = [];
  currFrameId = 0;
  frameFrequency = 20;
  mapWidth = 375;
  mapHeight = 812;
  // sessionId -> {gid, openId, zoneId} resolved from the one-time ticket in onAuth
  private sessions: Map<string, TicketPayload> = new Map();

  onCreate(options: any) {
    this.setSimulationInterval((deltaTime) => this.frameTick(deltaTime), 1000 / this.frameFrequency);

    // handle player submit
    this.onMessage("submitAction", (client, input) => {
      this.addAction(input);
    });
  }

  frameTick(deltaTime: number) {
    let frame = this.frameArray[this.currFrameId];
    if (!frame) {
      frame = new Frame();
      frame.frameId = this.currFrameId;
    }
    this.broadcast("broadcastFrame", frame);
    ++this.currFrameId;
  }

  addAction(action: Action) {
    let frame = this.frameArray[this.currFrameId];
    if (!frame) {
      frame = new Frame();
      frame.frameId = this.currFrameId;
      this.frameArray[this.currFrameId] = frame;
    }
    frame.actions.push(action);
  }

  // Same ticket-based identity recovery as StateSyncBattleRoom; see that file
  // for the full rationale.
  async onAuth(client: Client, options: any): Promise<TicketPayload> {
    const payload = consumeTicket(options?.ticket);
    if (!payload) {
      throw new ServerError(401, "invalid or expired battle ticket");
    }
    return payload;
  }

  onJoin(client: Client, options: any, auth?: TicketPayload) {
    if (!auth) {
      // Should be unreachable: Colyseus only calls onJoin after onAuth succeeds.
      throw new Error("onJoin called without auth payload");
    }
    dogsvr.infoLog(client.sessionId, auth.gid, auth.openId, auth.zoneId, "joined lockstep");
    this.sessions.set(client.sessionId, auth);
    this.addAction({
      vkey: "join",
      args: [Math.random() * this.mapWidth, Math.random() * this.mapHeight],
      playerId: client.sessionId
    });
    client.send(0, {
      frameArray: this.frameArray.length > 1 ? this.frameArray.slice(0, this.frameArray.length - 1) : [],
      frameFrequency: this.frameFrequency});
  }

  onLeave(client: Client, consented: boolean) {
    dogsvr.infoLog(client.sessionId, "left lockstep");
    const s = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    this.addAction({
      vkey: "leave",
      args: [],
      playerId: client.sessionId
    });

    if (!s) return;
    const scoreChange = Math.ceil(Math.random() * 10);
    dogsvr.callCmdByClc("zonesvr", {
      cmdId: cmdId.ZONE_BATTLE_END_NTF,
      openId: s.openId,
      zoneId: s.zoneId,
      gid: s.gid,
    }, JSON.stringify({ scoreChange: scoreChange }), true);
  }

  onDispose() {
    dogsvr.infoLog("room", this.roomId, "disposing lockstep...");
    this.sessions.clear();
  }

}
