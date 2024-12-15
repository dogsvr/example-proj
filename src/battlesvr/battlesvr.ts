import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { GrpcCL, GrpcCLC } from '@dogsvr/cl-grpc';

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: "./battlesvr_logic.js",
    workerThreadNum: 1,
    clMap: { "grpc": new GrpcCL(3001) },
    clcMap: { "zonesvr": new GrpcCLC("127.0.0.1:2001") }
}
dogsvr.startServer(svrCfg);
