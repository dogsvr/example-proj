import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
// @ts-expect-error
import express from "express";
import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { StateSyncBattleRoom } from "./rooms/state_sync_battle_room";
import { LockstepSyncBattleRoom } from "./rooms/lockstep_sync_battle_room";
import "./cmd_handler";

interface BattleSvrConfig extends dogsvr.WorkerThreadBaseConfig {
    colyseusPort: number;
}

function startColyseus(port: number) {
    const app = express();
    app.use(express.json());
    // colyseus 0.17: the HTTP `server` no longer lives on `ServerOptions`.
    // It must be passed to the transport, which in turn attaches to it.
    const gameServer = new Server({
        transport: new WebSocketTransport({
            server: createServer(app),
        }),
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
