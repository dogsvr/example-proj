import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import "./cmd_handler";
import { initMongo } from "../shared/mongo_proxy";

interface DirConfig extends dogsvr.WorkerThreadBaseConfig {
    mongoUri: string;
}

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<DirConfig>();
    await initMongo(cfg.mongoUri);
});
