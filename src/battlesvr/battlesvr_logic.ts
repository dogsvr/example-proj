import { workerData } from 'node:worker_threads';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { setupLoggerInWorker, type WorkerInitPayload, type Level } from '@dogsvr/logger/worker_thread';
// @ts-expect-error
import express from "express";
import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { StateSyncBattleRoom } from "./rooms/state_sync_battle_room";
import { LockstepSyncBattleRoom } from "./rooms/lockstep_sync_battle_room";
import "./cmd_handler";
import { setupOtelWorker } from '../otel/worker';

interface BattleSvrConfig extends dogsvr.WorkerThreadBaseConfig {
    log: { level: Level };
    colyseusPort: number;
}

function startColyseus(port: number) {
    const app = express();
    app.use(express.json());
    const gameServer = new Server({
        transport: new WebSocketTransport({
            server: createServer(app),
        }),
    });
    gameServer.define('state_sync_battle_room', StateSyncBattleRoom);
    gameServer.define('lockstep_sync_battle_room', LockstepSyncBattleRoom);
    gameServer.listen(port);
    app.get("/", (req: any, res: any) => {
        res.send("colyseus gm tool");
    });
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<BattleSvrConfig>();
    const loggerInit = (workerData as { loggerInit?: WorkerInitPayload }).loggerInit;
    if (!loggerInit) {
        throw new Error('workerData.loggerInit missing — was setupLogger called in main thread?');
    }
    setupLoggerInWorker({
        ...loggerInit,
        level: cfg.log.level,
        base: { svrId: 'battlesvr' },
    });
    setupOtelWorker('battlesvr');
    startColyseus(cfg.colyseusPort);
});
