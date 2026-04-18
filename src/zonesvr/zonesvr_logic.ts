import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import "./cmd_handler";
import { initRedis } from "../shared/redis_proxy";
import { initMongo, ensureRoleCollIndexes } from "../shared/mongo_proxy";

interface ZoneSvrConfig extends dogsvr.WorkerThreadBaseConfig {
    mongoUri: string;
    redisUri: string;
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<ZoneSvrConfig>();
    await Promise.all([
        initRedis(cfg.redisUri),
        initMongo(cfg.mongoUri).then(() => ensureRoleCollIndexes())
    ]);
});
