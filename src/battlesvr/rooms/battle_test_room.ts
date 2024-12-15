import { Room, Client } from "colyseus";
import { BattleTestState, Player } from "./battle_test_state";
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as cmdId from '../../shared/cmd_id';

export class BattleTestRoom extends Room<BattleTestState> {

  onCreate(options: any) {
    this.setState(new BattleTestState());

    // set map dimensions
    this.state.mapWidth = 800;
    this.state.mapHeight = 600;

    // handle player input
    this.onMessage(0, (client, input) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }
      const velocity = 2;
      if (input.left) {
        player.x -= velocity;

      } else if (input.right) {
        player.x += velocity;
      }
      if (input.up) {
        player.y -= velocity;

      } else if (input.down) {
        player.y += velocity;
      }
    });
  }

  onJoin(client: Client, options: any) {
    dogsvr.infoLog(client.sessionId, options.openId, options.zoneId, "joined!");

    // create player at random position.
    const player = new Player();
    player.openId = options.openId;
    player.zoneId = options.zoneId;
    player.x = Math.random() * this.state.mapWidth;
    player.y = Math.random() * this.state.mapHeight;

    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client, consented: boolean) {
    dogsvr.infoLog(client.sessionId, "left!");
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      return;
    }

    const scoreChange = Math.ceil(Math.random() * 10);

    dogsvr.callCmdByClc("zonesvr", {
      cmdId: cmdId.ZONE_BATTLE_END_NTF,
      openId: player.openId,
      zoneId: player.zoneId
    }, JSON.stringify({ scoreChange: scoreChange }), true);

    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    dogsvr.infoLog("room", this.roomId, "disposing...");
  }

}
