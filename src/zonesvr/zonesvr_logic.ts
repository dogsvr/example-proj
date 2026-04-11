import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import "./cmd_handler";
import { initRedis } from "../shared/redis_proxy";
import { initMongo, ensureRoleCollIndexes } from "../shared/mongo_proxy";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

dogsvr.workerReady(async () => {
    await Promise.all([
        initRedis(),
        initMongo().then(() => ensureRoleCollIndexes())
    ]);
});
