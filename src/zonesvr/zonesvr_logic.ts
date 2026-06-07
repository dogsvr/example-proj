import { workerData } from 'node:worker_threads';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { setupLoggerInWorker, type WorkerInitPayload } from '@dogsvr/logger/worker_thread';
import "./cmd_handler";
import { initRedis } from "../shared/redis_proxy";
import { initMongo, ensureRoleCollIndexes } from "../shared/mongo_proxy";
import { openCfgDb } from '@dogsvr/cfg-luban';
import * as cfgModule from 'example-proj-cfg';
import * as path from 'node:path';

interface ZoneSvrConfig extends dogsvr.WorkerThreadBaseConfig {
    log: { level: dogsvr.Level };
    mongoUri: string;
    redisUri: string;
    cfgDbPath: string;      // relative to __dirname (dist/zonesvr/) or absolute
    tableKeysPath: string;  // relative to __dirname or absolute
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<ZoneSvrConfig>();
    const loggerInit = (workerData as { loggerInit?: WorkerInitPayload }).loggerInit;
    if (!loggerInit) {
        throw new Error('workerData.loggerInit missing — was setupLogger called in main thread?');
    }
    setupLoggerInWorker({
        ...loggerInit,
        level: cfg.log.level,
        base: { svrId: 'zonesvr' },
    });
    // Open cfg DB before async init: handlers may call getCfgRow at any moment.
    openCfgDb({
        dbPath: path.resolve(__dirname, cfg.cfgDbPath),
        tableKeysPath: path.resolve(__dirname, cfg.tableKeysPath),
        cfgModule
    });
    await Promise.all([
        initRedis(cfg.redisUri),
        initMongo(cfg.mongoUri).then(() => ensureRoleCollIndexes())
    ]);
});
