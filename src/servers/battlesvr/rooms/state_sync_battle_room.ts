import { Room, Client, ServerError } from "colyseus";
import { Schema, type, ArraySchema, MapSchema } from "@colyseus/schema";
// @ts-expect-error
import * as Matter from "matter-js";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../../protocols/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';
import {
    observeTickDuration, incRoomCount, decRoomCount,
    incRoomClients, decRoomClients,
} from '../../../otel/metrics_worker';

const log = dogsvr.log.child({ module: 'state_sync_battle_room' });

const ROOM_TYPE = 'state_sync';

// Gameplay: auto-fire bullets, bounce off walls, kill non-owner players, respawn with invuln.
const MAP_W = 800;
const MAP_H = 1200;
const PLAYER_SIZE = 20;
const BALL_RADIUS = 5;
const PLAYER_SPEED = 3;            // units per 60fps tick; Matter scales internally
const BALL_SPEED = 5;
const FIRE_INTERVAL = 1000;        // ms
const BALL_TTL = 5000;             // ms
const INVULN_DURATION = 2500;      // ms (spawn + post-kill)
const MAX_PLAYERS = 8;             // caps room size AND palette size

// Matter collision categories. Players don't collide with each other
// (overlap freely); bullets collide with everything.
const CAT_WALL = 0x0001;
const CAT_PLAYER = 0x0002;
const CAT_BALL = 0x0004;

// Must match client.
const STATE_ALIVE = 0;
const STATE_INVULN = 1;

// `state` declared first: Colyseus 0.17 fires `listen` callbacks in declaration order;
// client's state→invuln-ring logic fires before x/y, so explosion plays at death position.
class Player extends Schema {
  @type("uint8")  state: number = STATE_INVULN;  // declared first — see class comment
  @type("uint8")  colorIdx: number = 0;
  @type("uint16") kills: number = 0;
  @type("uint16") deaths: number = 0;
  @type("number") gid: number = 0;
  @type("number") x: number = 0;
  @type("number") y: number = 0;

  // server-only fields (not serialised):
  openId: string = "";
  zoneId: number = 0;
  body: Matter.Body | null = null;
  lastDirX: number = 0;
  lastDirY: number = 0;
  hasMoved: boolean = false;
  invulnUntilTs: number = 0;
  nextFireTs: number = 0;
}

class Ball extends Schema {
  @type("string") ownerSessionId: string = "";   // set once, on spawn
  @type("number") x: number = 0;
  @type("number") y: number = 0;

  // server-only:
  body: Matter.Body | null = null;
  createTs: number = 0;
}

class RoomState extends Schema {
  @type("number") mapWidth: number = MAP_W;
  @type("number") mapHeight: number = MAP_H;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Ball]) balls = new ArraySchema<Ball>();
}

// Kill event buffered out of the Matter mid-step to avoid mutating world mid-step.
type PendingKill = { victim: Player; owner: Player; ball: Ball };

export class StateSyncBattleRoom extends Room<{ state: RoomState }> {
  engine: Matter.Engine;
  maxClients = MAX_PLAYERS;
  private pendingKills: PendingKill[] = [];
  private sessionIdByPlayer: Map<Player, string> = new Map();
  private colorSlotTaken: boolean[] = new Array(MAX_PLAYERS).fill(false);

  onCreate(options: any) {
    this.setState(new RoomState());
    this.state.mapWidth = MAP_W;
    this.state.mapHeight = MAP_H;

    this.initPhysics();
    this.registerCollisionHandler();
    this.setSimulationInterval((deltaTime) => this.tickWithMetrics(deltaTime));
    incRoomCount(ROOM_TYPE);

    this.onMessage(0, (client, input) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.body) return;

      let dx = Math.max(-1, Math.min(1, typeof input?.dx === 'number' ? input.dx : 0));
      let dy = Math.max(-1, Math.min(1, typeof input?.dy === 'number' ? input.dy : 0));
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; }

      Matter.Body.setVelocity(player.body, { x: dx * PLAYER_SPEED, y: dy * PLAYER_SPEED });

      if (mag > 0) {
        const inv = 1 / Math.min(mag, 1);
        player.lastDirX = dx * inv;
        player.lastDirY = dy * inv;
        if (!player.hasMoved) {
          player.hasMoved = true;
          player.nextFireTs = this.engine.timing.timestamp + FIRE_INTERVAL;
        }
      }
    });
  }

  private initPhysics() {
    this.engine = Matter.Engine.create();
    this.engine.gravity.y = 0;

    // Walls: thick slabs outside play area to prevent bullet tunneling.
    const wallThick = 1000;
    const wallOpts = {
      isStatic: true,
      restitution: 1,
      friction: 0,
      frictionStatic: 0,
      collisionFilter: { category: CAT_WALL, mask: CAT_PLAYER | CAT_BALL },
    };
    const walls = [
      Matter.Bodies.rectangle(-wallThick / 2, MAP_H / 2, wallThick, MAP_H + wallThick * 2, wallOpts),        // left
      Matter.Bodies.rectangle(MAP_W + wallThick / 2, MAP_H / 2, wallThick, MAP_H + wallThick * 2, wallOpts), // right
      Matter.Bodies.rectangle(MAP_W / 2, -wallThick / 2, MAP_W + wallThick * 2, wallThick, wallOpts),        // top
      Matter.Bodies.rectangle(MAP_W / 2, MAP_H + wallThick / 2, MAP_W + wallThick * 2, wallThick, wallOpts), // bottom
    ];
    Matter.Composite.add(this.engine.world, walls);
  }

  private registerCollisionHandler() {
    // collisionStart fires inside Engine.update — enqueue kills, drain after update.
    Matter.Events.on(this.engine, 'collisionStart', (event: any) => {
      for (const pair of event.pairs) {
        const pa = pair.bodyA.plugin ?? {};
        const pb = pair.bodyB.plugin ?? {};

        let ball: Ball | null = null, player: Player | null = null;
        if (pa.ball && pb.player) { ball = pa.ball; player = pb.player; }
        else if (pb.ball && pa.player) { ball = pb.ball; player = pa.player; }
        else continue; // wall↔ball, ball↔ball, wall↔player

        // Self-bounce / invuln / orphan: skip.
        const owner = this.state.players.get(ball!.ownerSessionId);
        if (owner === player) continue;
        if (player!.state === STATE_INVULN) continue;
        if (!owner) continue;

        this.pendingKills.push({ victim: player!, owner, ball: ball! });
      }
    });
  }

  private tickWithMetrics(deltaTime: number) {
    const start = process.hrtime.bigint();
    this.update(deltaTime);
    observeTickDuration(ROOM_TYPE, Number(process.hrtime.bigint() - start) / 1e6);
  }

  private update(deltaTime: number) {
    Matter.Engine.update(this.engine, deltaTime);
    const now = this.engine.timing.timestamp;

    // 1. Drain kills queued during Engine.update; de-dup by victim+ball.
    if (this.pendingKills.length > 0) {
      const killedBalls = new Set<Ball>();
      const killedVictims = new Set<Player>();
      for (const k of this.pendingKills) {
        if (killedBalls.has(k.ball) || killedVictims.has(k.victim)) continue;
        killedBalls.add(k.ball);
        killedVictims.add(k.victim);

        k.owner.kills++;
        k.victim.deaths++;
        this.removeBall(k.ball);
        this.respawnPlayer(k.victim, now);
      }
      this.pendingKills.length = 0;
    }

    // 2. Per-player: expire invuln, auto-fire.
    for (const [sid, player] of this.state.players) {
      if (!player.body) continue;

      if (player.state === STATE_INVULN && now >= player.invulnUntilTs) {
        player.state = STATE_ALIVE;
      }

      if (player.hasMoved && now >= player.nextFireTs) {
        this.spawnBall(player, sid, now);
        // Accumulate to keep cadence steady under tick jitter.
        player.nextFireTs += FIRE_INTERVAL;
      }
    }

    // 3. Expire balls past TTL. Reverse iterate for splice safety.
    for (let i = this.state.balls.length - 1; i >= 0; i--) {
      const ball = this.state.balls[i];
      if (!ball) continue;
      if (now >= ball.createTs + BALL_TTL) {
        this.removeBall(ball);
      }
    }

    // 4. Mirror Matter body positions into the schema for the client.
    for (const player of this.state.players.values()) {
      if (player.body) {
        player.x = player.body.position.x;
        player.y = player.body.position.y;
      }
    }
    for (const ball of this.state.balls) {
      if (ball.body) {
        ball.x = ball.body.position.x;
        ball.y = ball.body.position.y;
      }
    }
  }

  private spawnBall(player: Player, sid: string, now: number) {
    const ball = new Ball();
    ball.ownerSessionId = sid;
    ball.x = player.body!.position.x;
    ball.y = player.body!.position.y;
    ball.createTs = now;

    ball.body = Matter.Bodies.circle(ball.x, ball.y, BALL_RADIUS, {
      frictionAir: 0,
      friction: 0,
      frictionStatic: 0,
      restitution: 1,
      inertia: Infinity,                   // bullets don't spin
      collisionFilter: { category: CAT_BALL, mask: CAT_WALL | CAT_PLAYER | CAT_BALL },
    });
    ball.body.plugin = { ball };

    Matter.Body.setVelocity(ball.body, {
      x: player.lastDirX * BALL_SPEED,
      y: player.lastDirY * BALL_SPEED,
    });

    Matter.Composite.add(this.engine.world, ball.body);
    this.state.balls.push(ball);
  }

  private removeBall(ball: Ball) {
    if (ball.body) {
      Matter.Composite.remove(this.engine.world, ball.body);
      ball.body = null;
    }
    const idx = this.state.balls.indexOf(ball);
    if (idx >= 0) this.state.balls.splice(idx, 1);
  }

  private respawnPlayer(player: Player, now: number) {
    const x = Math.random() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
    const y = Math.random() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;
    if (player.body) {
      Matter.Body.setPosition(player.body, { x, y });
      Matter.Body.setVelocity(player.body, { x: 0, y: 0 });
    }
    player.x = x;
    player.y = y;
    player.state = STATE_INVULN;
    player.invulnUntilTs = now + INVULN_DURATION;
    player.hasMoved = false;
    player.lastDirX = 0;
    player.lastDirY = 0;
  }

  private allocColorSlot(): number {
    for (let i = 0; i < this.colorSlotTaken.length; i++) {
      if (!this.colorSlotTaken[i]) {
        this.colorSlotTaken[i] = true;
        return i;
      }
    }
    return 0;
  }

  private releaseColorSlot(idx: number): void {
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

    const now = this.engine.timing.timestamp;
    const player = new Player();
    player.gid = auth.gid;
    player.openId = auth.openId;
    player.zoneId = auth.zoneId;
    player.colorIdx = this.allocColorSlot();
    player.x = Math.random() * (MAP_W - PLAYER_SIZE) + PLAYER_SIZE / 2;
    player.y = Math.random() * (MAP_H - PLAYER_SIZE) + PLAYER_SIZE / 2;
    player.state = STATE_INVULN;
    player.invulnUntilTs = now + INVULN_DURATION;

    player.body = Matter.Bodies.rectangle(player.x, player.y, PLAYER_SIZE, PLAYER_SIZE, {
      frictionAir: 0.08,
      friction: 0,
      frictionStatic: 0,
      restitution: 1,
      inertia: Infinity,
      collisionFilter: { category: CAT_PLAYER, mask: CAT_WALL | CAT_BALL },
    });
    player.body.plugin = { player };
    Matter.Composite.add(this.engine.world, player.body);

    this.sessionIdByPlayer.set(player, client.sessionId);
    this.state.players.set(client.sessionId, player);
    incRoomClients(ROOM_TYPE);
  }

  // colyseus 0.17: onLeave's 2nd arg is close code, not consented bool.
  onLeave(client: Client, code?: number) {
    log.info({ sessionId: client.sessionId }, "left");
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    decRoomClients(ROOM_TYPE);

    const scoreChange = player.kills;

    dogsvr.callCmdByClc("zonesvr", {
      cmdId: cmdId.ZONE_BATTLE_END_NTF,
      openId: player.openId,
      zoneId: player.zoneId,
      gid: player.gid,
    }, JSON.stringify({ scoreChange }), true);

    if (player.body) {
      Matter.Composite.remove(this.engine.world, player.body);
    }
    this.releaseColorSlot(player.colorIdx);
    this.sessionIdByPlayer.delete(player);
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    log.info({ roomId: this.roomId }, "room disposing");
    decRoomCount(ROOM_TYPE);
  }
}
