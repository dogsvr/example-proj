import { workerData } from 'node:worker_threads';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { setupLoggerInWorker, type WorkerInitPayload, type Level } from '@dogsvr/logger/worker_thread';
import "./cmd_handler";
import { initMongo } from "../shared/mongo_proxy";
import { setupOtelWorker } from '../shared/otel';

interface DirConfig extends dogsvr.WorkerThreadBaseConfig {
    log: { level: Level };
    mongoUri: string;
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<DirConfig>();
    const loggerInit = (workerData as { loggerInit?: WorkerInitPayload }).loggerInit;
    if (!loggerInit) {
        throw new Error('workerData.loggerInit missing — was setupLogger called in main thread?');
    }
    setupLoggerInWorker({
        ...loggerInit,
        level: cfg.log.level,
        base: { svrId: 'dir' },
    });
    setupOtelWorker('dir');
    await initMongo(cfg.mongoUri);
});
