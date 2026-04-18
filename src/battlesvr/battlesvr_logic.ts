import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
// @ts-expect-error
import express from "express";
import { createServer } from "http";
import { Server } from "colyseus";
import { StateSyncBattleRoom } from "./rooms/state_sync_battle_room";
import { LockstepSyncBattleRoom } from "./rooms/lockstep_sync_battle_room";
import "./cmd_handler";

interface BattleSvrConfig extends dogsvr.WorkerThreadBaseConfig {
    colyseusPort: number;
}

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
    gameServer.define('lockstep_sync_battle_room', LockstepSyncBattleRoom);
    gameServer.listen(port);
    // gm tool by express
    app.get("/", (req: any, res: any) => {
        res.send("colyseus gm tool");
    });
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<BattleSvrConfig>();
    startColyseus(cfg.colyseusPort);
});
