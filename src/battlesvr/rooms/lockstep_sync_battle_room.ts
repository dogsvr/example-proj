import { Room, Client, ServerError } from "colyseus";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../protocols/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';

// Lockstep battle room. Gameplay rules match state-sync (shooting, self-
// ball bounce, enemy-ball kill, respawn with invuln, kill tally), but all
// physics / game logic runs on the CLIENT. Server responsibilities:
//   1. generate seed and send to each joining client
//   2. broadcast action frames at 20 fps
//   3. relay player input
//   4. inject join/leave actions
//   5. collect `reportKills` from the client so onLeave can emit
//      ZONE_BATTLE_END_NTF with the real kill count
//
// Late joiners receive the history of closed frames and fast-forward
// locally; combined with the deterministic client sim this rebuilds the
// current world state. A spawn-position snapshot alone would miss
// in-flight bullets / kill counts / invuln timers that happened since.
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
  // Colour-slot pool: same scheme as state-sync for cross-client stability.
  private colorSlotTaken: boolean[] = new Array(MAX_PLAYERS).fill(false);
  // Per-client housekeeping. Colyseus 0.17 doesn't pass auth to onLeave, so
  // we cache it here; finalKills arrives via `reportKills` just before leave.
  private authBySid: Map<string, TicketPayload> = new Map();
  private colorIdxBySid: Map<string, number> = new Map();
  private finalKills: Map<string, number> = new Map();

  onCreate(options: any) {
    // 32-bit unsigned seed feeds the client's mulberry32 PRNG for any
    // draw that must stay lockstep-consistent (respawn position).
    this.seed = (Math.random() * 0xFFFFFFFF) >>> 0;

    this.frameArray.push(new Frame(0));
    this.setSimulationInterval((_dt) => this.frameTick(), FRAME_INTERVAL);

    this.onMessage("submitAction", (client, action: { vkey: string; args: any[] }) => {
      if (!action || typeof action.vkey !== 'string') return;
      this.addAction({ vkey: action.vkey, args: action.args ?? [], playerId: client.sessionId });
    });

    this.onMessage("reportKills", (client, n: number) => {
      // Trust the client (demo). May fire multiple times; last value wins.
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        this.finalKills.set(client.sessionId, Math.floor(n));
      }
    });
  }

  private frameTick() {
    // Broadcast the frame that just closed, open a fresh one. Clients
    // drain frames out of their local buffer in execFrame order.
    const closed = this.frameArray[this.frameArray.length - 1];
    this.broadcast("broadcastFrame", closed);
    this.currFrameId++;
    this.frameArray.push(new Frame(this.currFrameId));
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
    dogsvr.infoLog(client.sessionId, auth.gid, auth.openId, auth.zoneId, "joined!");

    const colorIdx = this.allocColorSlot();
    this.authBySid.set(client.sessionId, auth);
    this.colorIdxBySid.set(client.sessionId, colorIdx);

    // Non-deterministic Math.random is fine — the join action carries the
    // resolved spawn position so clients don't re-roll it.
    const spawnX = Math.random() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
    const spawnY = Math.random() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;

    // Capture history BEFORE adding our join — the join lands in the
    // currently-open frame, which the newcomer receives via broadcastFrame
    // (not historicalFrames), avoiding a double-create of self.
    const historicalFrames = this.frameArray.slice(0, -1);

    this.addAction({
      vkey: 'join',
      playerId: client.sessionId,
      args: [client.sessionId, auth.gid, colorIdx, spawnX, spawnY],
    });

    // Init packet with history so the client fast-forwards to the current
    // world state. Cost: O(N frames) payload + replay CPU. Fine for
    // demo-scale matches; long-running rooms would snapshot+compact.
    client.send(0, {
      seed: this.seed,
      selfSessionId: client.sessionId,
      mapWidth: MAP_W,
      mapHeight: MAP_H,
      historicalFrames,
    });
  }

  // colyseus 0.17: onLeave's 2nd arg is `code?: number` (close code), not
  // `consented: boolean` like 0.16. We don't branch on it.
  onLeave(client: Client, code?: number) {
    dogsvr.infoLog(client.sessionId, "left!");
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
  }

  onDispose() {
    dogsvr.infoLog("room", this.roomId, "disposing...");
    // setSimulationInterval is auto-cleared by Colyseus on dispose.
  }
}
