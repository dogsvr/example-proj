import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import "./role";
import { initRedis } from "./redis_proxy";
import { initMongo } from "./mongo_proxy";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

initRedis();
initMongo();
