import { Room, Client } from "colyseus";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../shared/cmd_id';

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

  onJoin(client: Client, options: any) {
    dogsvr.infoLog(client.sessionId, options.openId, options.zoneId, "joined lockstep");
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
    this.addAction({
      vkey: "leave",
      args: [],
      playerId: client.sessionId
    });
  }

  onDispose() {
    dogsvr.infoLog("room", this.roomId, "disposing lockstep...");
  }

}
