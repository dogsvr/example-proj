import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  openId: string = "";
  zoneId: number = 0;
}

export class BattleTestState extends Schema {
  @type("number") mapWidth: number = 0;
  @type("number") mapHeight: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
}
