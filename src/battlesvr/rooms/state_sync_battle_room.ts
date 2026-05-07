import { Room, Client, ServerError } from "colyseus";
import { Schema, type, ArraySchema, MapSchema } from "@colyseus/schema";
// @ts-expect-error
import * as Matter from "matter-js";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../protocols/cmd_id';
import { consumeTicket, TicketPayload } from '../session_ticket';

class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") gid: number = 0;
  openId: string = "";
  zoneId: number = 0;
  body: Matter.Body | null = null;
}

class Ball extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  body: Matter.Body | null = null;
}

class RoomState extends Schema {
  @type("number") mapWidth: number = 0;
  @type("number") mapHeight: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Ball]) balls = new ArraySchema<Ball>();
}

export class StateSyncBattleRoom extends Room<{ state: RoomState }> {
  engine: Matter.Engine;
  interval: NodeJS.Timeout | undefined;

  onCreate(options: any) {
    this.setState(new RoomState());

    // set map dimensions
    this.state.mapWidth = 375;
    this.state.mapHeight = 812;

    this.initPhysics();
    this.setSimulationInterval((deltaTime) => this.update(deltaTime));

    // handle player input
    this.onMessage(0, (client, input) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }
      const velocity = 4;
      let x = player.body.position.x;
      let y = player.body.position.y;
      if (input.left) {
        x -= velocity;

      } else if (input.right) {
        x += velocity;
      }
      if (input.up) {
        y -= velocity;

      } else if (input.down) {
        y += velocity;
      }
      Matter.Body.setPosition(player.body, { x: x, y: y });
    });

    this.interval = setInterval(() => {
      // create ball
      for (let player of this.state.players.values()) {
        if (!player.body) {
          continue;
        }
        const ball = new Ball();
        ball.x = player.body.position.x;
        ball.y = player.body.position.y;
        ball.body = Matter.Bodies.circle(ball.x, ball.y, 5, { frictionAir: 0, restitution: 1 });
        Matter.Body.setVelocity(ball.body, { x: 0, y: player.body.position.y < this.state.mapHeight / 2 ? 5 : -5 });
        Matter.Composite.add(this.engine.world, ball.body);
        ball.body.createTs = this.engine.timing.timestamp;
        this.state.balls.push(ball);
      }
      // remove timeout ball
      for (let i = 0; i < this.state.balls.length; ++i) {
        let ball = this.state.balls[i];
        if (!ball) {
          continue;
        }
        if (ball.body.createTs + 10 * 1000 < this.engine.timing.timestamp) {
          Matter.Composite.remove(this.engine.world, ball.body);
          this.state.balls.splice(i, 1);
          --i;
        }
      }
    }, 2000);
  }

  initPhysics() {
    this.engine = Matter.Engine.create();
    this.engine.gravity.y = 0;
    // create wall
    const wallWidth = 1000;
    const wallHeight = 1000;
    const wallMargin = 0;
    const wallLeft = Matter.Bodies.rectangle(wallMargin - wallWidth / 2, this.state.mapHeight / 2, wallWidth, wallHeight, { isStatic: true });
    const wallRight = Matter.Bodies.rectangle(this.state.mapWidth + wallWidth / 2 - wallMargin, this.state.mapHeight / 2, wallWidth, wallHeight, { isStatic: true });
    const wallTop = Matter.Bodies.rectangle(this.state.mapWidth / 2, wallMargin - wallHeight / 2, wallWidth, wallHeight, { isStatic: true });
    const wallBottom = Matter.Bodies.rectangle(this.state.mapWidth / 2, this.state.mapHeight + wallHeight / 2 - wallMargin, wallWidth, wallHeight, { isStatic: true });
    Matter.Composite.add(this.engine.world, [wallLeft, wallRight, wallTop, wallBottom]);
  }

  update(deltaTime: number) {
    Matter.Engine.update(this.engine, deltaTime);

    for (let player of this.state.players.values()) {
      if (player.body) {
        player.x = player.body.position.x;
        player.y = player.body.position.y;
      }
    }
    for (let ball of this.state.balls) {
      if (ball.body) {
        ball.x = ball.body.position.x;
        ball.y = ball.body.position.y;
      }
    }
  }

  // Verify a one-time ticket from BATTLE_START_BATTLE to recover the
  // authenticated identity, so the client cannot spoof via joinOptions.
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
    dogsvr.infoLog(client.sessionId, auth.gid, auth.openId, auth.zoneId, "joined!");

    // create player at random position.
    const player = new Player();
    player.gid = auth.gid;
    player.openId = auth.openId;
    player.zoneId = auth.zoneId;
    player.x = Math.random() * this.state.mapWidth;
    player.y = Math.random() * this.state.mapHeight;

    player.body = Matter.Bodies.rectangle(player.x, player.y, 20, 20, { frictionAir: 0 });
    Matter.Composite.add(this.engine.world, player.body);

    this.state.players.set(client.sessionId, player);
  }

  // colyseus 0.17: onLeave's 2nd arg changed from `consented: boolean` to
  // `code?: number` (WebSocket close code). We don't branch on it.
  onLeave(client: Client, code?: number) {
    dogsvr.infoLog(client.sessionId, "left!");
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      return;
    }

    const scoreChange = Math.ceil(Math.random() * 10);

    dogsvr.callCmdByClc("zonesvr", {
      cmdId: cmdId.ZONE_BATTLE_END_NTF,
      openId: player.openId,
      zoneId: player.zoneId,
      gid: player.gid,
    }, JSON.stringify({ scoreChange: scoreChange }), true);

    Matter.Composite.remove(this.engine.world, player.body);
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    dogsvr.infoLog("room", this.roomId, "disposing...");
    clearInterval(this.interval);
  }

}
