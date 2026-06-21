import { Room, Client, ServerError } from "colyseus";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../protocols/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';
import {
    observeTickDuration, incRoomCount, decRoomCount,
    incRoomClients, decRoomClients, recordBroadcast,
} from '../../shared/otel_metrics_worker';

const log = dogsvr.log.child({ module: 'battlesvr/rooms/lockstep_sync_battle_room' });

const ROOM_TYPE = 'lockstep_sync';

// Lockstep battle room: seed + frame broadcast at 20fps + input relay.
// Server collects reportKills for ZONE_BATTLE_END_NTF on leave.
// Late joiners receive historicalFrames for client-side fast-forward.
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const MAX_PLAYERS = 8;
const FRAME_INTERVAL = 50;   // ms — 20 fps

type Action = { vkey: string; args: any[]; playerId: string };
class Frame {
  frameId: number;
  actions: Action[] = [];
  constructor(frameId: number) { this.frameId = frameId; }
}

export class LockstepSyncBattleRoom extends Room {
  maxClients = MAX_PLAYERS;

  private seed: number = 0;
  private frameArray: Frame[] = [];
  private currFrameId: number = 0;
  private colorSlotTaken: boolean[] = new Array(MAX_PLAYERS).fill(false);
  // Colyseus 0.17 doesn't pass auth to onLeave; cache auth + finalKills here.
  private authBySid: Map<string, TicketPayload> = new Map();
  private colorIdxBySid: Map<string, number> = new Map();
  private finalKills: Map<string, number> = new Map();

  onCreate(options: any) {
    this.seed = (Math.random() * 0xFFFFFFFF) >>> 0;

    this.frameArray.push(new Frame(0));
    this.setSimulationInterval((_dt) => this.frameTick(), FRAME_INTERVAL);
    incRoomCount(ROOM_TYPE);
    incRoomCount(ROOM_TYPE);

    this.onMessage("submitAction", (client, action: { vkey: string; args: any[] }) => {
      if (!action || typeof action.vkey !== 'string') return;
      this.addAction({ vkey: action.vkey, args: action.args ?? [], playerId: client.sessionId });
    });

    this.onMessage("reportKills", (client, n: number) => {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        this.finalKills.set(client.sessionId, Math.floor(n));
      }
    });
  }

  private frameTick() {
    const start = process.hrtime.bigint();
    // Broadcast the closed frame, open a fresh one.
    const closed = this.frameArray[this.frameArray.length - 1];
    this.broadcast("broadcastFrame", closed);
    recordBroadcast(ROOM_TYPE);
    this.currFrameId++;
    this.frameArray.push(new Frame(this.currFrameId));
    observeTickDuration(ROOM_TYPE, Number(process.hrtime.bigint() - start) / 1e6);
  }

  private addAction(action: Action) {
    this.frameArray[this.frameArray.length - 1].actions.push(action);
  }

  private allocColorSlot(): number {
    for (let i = 0; i < this.colorSlotTaken.length; i++) {
      if (!this.colorSlotTaken[i]) { this.colorSlotTaken[i] = true; return i; }
    }
    return 0; // unreachable under maxClients cap
  }

  private releaseColorSlot(idx: number | undefined): void {
    if (idx === undefined) return;
    if (idx >= 0 && idx < this.colorSlotTaken.length) this.colorSlotTaken[idx] = false;
  }

  async onAuth(client: Client, options: any): Promise<TicketPayload> {
    const payload = consumeTicket(options?.ticket);
    if (!payload) {
      throw new ServerError(401, "invalid or expired battle ticket");
    }
    return payload;
  }

  onJoin(client: Client, options: any, auth?: TicketPayload) {
    if (!auth) {
      throw new Error("onJoin called without auth payload");
    }
    log.info({ sessionId: client.sessionId, gid: auth.gid, openId: auth.openId, zoneId: auth.zoneId }, "joined");

    const colorIdx = this.allocColorSlot();
    this.authBySid.set(client.sessionId, auth);
    this.colorIdxBySid.set(client.sessionId, colorIdx);

    const spawnX = Math.random() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
    const spawnY = Math.random() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;

    // Capture history before adding our join action so late-joiners don't double-create self.
    const historicalFrames = this.frameArray.slice(0, -1);

    this.addAction({
      vkey: 'join',
      playerId: client.sessionId,
      args: [client.sessionId, auth.gid, colorIdx, spawnX, spawnY],
    });

    client.send(0, {
      seed: this.seed,
      selfSessionId: client.sessionId,
      mapWidth: MAP_W,
      mapHeight: MAP_H,
      historicalFrames,
    });
    incRoomClients(ROOM_TYPE);
  }

  // colyseus 0.17: onLeave's 2nd arg is close code, not consented bool.
  onLeave(client: Client, code?: number) {
    log.info({ sessionId: client.sessionId }, "left");
    const sid = client.sessionId;
    const auth = this.authBySid.get(sid);

    if (auth) {
      const scoreChange = this.finalKills.get(sid) ?? 0;
      dogsvr.callCmdByClc("zonesvr", {
        cmdId: cmdId.ZONE_BATTLE_END_NTF,
        openId: auth.openId,
        zoneId: auth.zoneId,
        gid: auth.gid,
      }, JSON.stringify({ scoreChange }), true);
    }

    this.addAction({ vkey: 'leave', playerId: sid, args: [sid] });
    this.releaseColorSlot(this.colorIdxBySid.get(sid));
    this.authBySid.delete(sid);
    this.colorIdxBySid.delete(sid);
    this.finalKills.delete(sid);
    decRoomClients(ROOM_TYPE);
  }

  onDispose() {
    log.info({ roomId: this.roomId }, "room disposing");
    decRoomCount(ROOM_TYPE);
  }
}
