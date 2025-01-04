import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
// @ts-expect-error
import express from "express";
import { createServer } from "http";
import { Server } from "colyseus";
import { StateSyncBattleRoom } from "./rooms/state_sync_battle_room";
import "./cmd_handler";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

function startColyseus(port: number) {
    const app = express();
    app.use(express.json());
    const gameServer = new Server({
        server: createServer(app),
        // transport: new uWebSocketsTransport(),
        // driver: new RedisDriver(),
        // presence: new RedisPresence(),
    });
    gameServer.define('state_sync_battle_room', StateSyncBattleRoom);
    gameServer.listen(port);
    // gm tool by express
    app.get("/", (req: any, res: any) => {
        res.send("colyseus gm tool");
    });
}
startColyseus(2567);
