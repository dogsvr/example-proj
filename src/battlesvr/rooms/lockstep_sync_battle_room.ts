import { Room, Client, ServerError } from "colyseus";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../protocols/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';

// ──────────────────────────────────────────────────────────────────────────
// Lockstep battle room. Gameplay rules match state-sync exactly — shooting,
// self-ball bounce, enemy-ball kill, respawn with invuln, kill tally — but
// all physics / game logic runs on the client. The server only:
//   1. generates a room seed and sends it to each joining client
//   2. maintains a broadcast frame queue at 20 fps
//   3. relays player input into the current frame
//   4. injects join/leave actions so clients can materialise/remove entities
//   5. collects `reportKills` from clients so it can emit ZONE_BATTLE_END_NTF
//      with the real kill count on onLeave.
//
// Late joiners receive the full history of CLOSED frames on connect and
// fast-forward through them locally; combined with the deterministic
// client-side sim this rebuilds the exact current world state (player
// positions, in-flight bullets, kill counts, invuln timers). A snapshot
// of spawn positions alone is insufficient — there's no way to recover
// what happened between join and now without replaying the action stream.
// ──────────────────────────────────────────────────────────────────────────
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
  // Colour-slot pool: same scheme as state-sync so every client sees a
  // stable, consistent colour per player.
  private colorSlotTaken: boolean[] = new Array(MAX_PLAYERS).fill(false);
  // Per-client housekeeping: auth survives onAuth → onJoin → onLeave
  // (Colyseus 0.17 doesn't pass auth to onLeave); colorIdx released on
  // leave; finalKills arrives via `reportKills` just before the client
  // issues its leave request.
  private authBySid: Map<string, TicketPayload> = new Map();
  private colorIdxBySid: Map<string, number> = new Map();
  private finalKills: Map<string, number> = new Map();

  onCreate(options: any) {
    // 32-bit unsigned room seed — clients feed this into a shared mulberry32
    // PRNG for any draw that must stay lockstep-consistent (respawn pos).
    this.seed = (Math.random() * 0xFFFFFFFF) >>> 0;

    this.frameArray.push(new Frame(0));
    this.setSimulationInterval((_dt) => this.frameTick(), FRAME_INTERVAL);

    this.onMessage("submitAction", (client, action: { vkey: string; args: any[] }) => {
      if (!action || typeof action.vkey !== 'string') return;
      this.addAction({ vkey: action.vkey, args: action.args ?? [], playerId: client.sessionId });
    });

    this.onMessage("reportKills", (client, n: number) => {
      // Trust the client (demo). Clamp to non-negative int. reportKills may
      // fire multiple times; the last value before onLeave wins.
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

    // Non-deterministic Math.random is fine here — the join action carries
    // the resolved spawn position so clients don't need to re-roll it.
    const spawnX = Math.random() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
    const spawnY = Math.random() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;

    // Capture the history BEFORE adding our join action. The join goes into
    // the currently-open frame which will broadcast next frameTick — the
    // newcomer will receive it through the normal broadcastFrame stream
    // (not through historicalFrames), avoiding a double-create of self.
    // `historicalFrames` = every frame already closed + broadcast to others.
    const historicalFrames = this.frameArray.slice(0, -1);

    this.addAction({
      vkey: 'join',
      playerId: client.sessionId,
      args: [client.sessionId, auth.gid, colorIdx, spawnX, spawnY],
    });

    // Init packet. `historicalFrames` lets the client fast-forward its
    // local sim to the current world state before applying live frames.
    // Cost: O(N frames) JSON payload + O(N × step) client CPU during
    // replay. Acceptable for a demo-scale match; for long-running rooms
    // we'd snapshot + compact every few minutes.
    client.send(0, {
      seed: this.seed,
      selfSessionId: client.sessionId,
      mapWidth: MAP_W,
      mapHeight: MAP_H,
      historicalFrames,
    });
  }

  // colyseus 0.17: onLeave's 2nd arg changed from `consented: boolean` to
  // `code?: number` (WebSocket close code). We don't branch on it.
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
