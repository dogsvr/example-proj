import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import express from "express";
import { createServer } from "http";
import { Server } from "colyseus";
import { BattleTestRoom } from "./rooms/battle_test_room";
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
    gameServer.define('battle_test_room', BattleTestRoom);
    gameServer.listen(port);
    // gm tool by express
    app.get("/", (req: any, res: any) => {
        res.send("colyseus gm tool");
    });
}
startColyseus(2567);
