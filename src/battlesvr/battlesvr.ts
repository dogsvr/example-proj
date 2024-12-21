import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { GrpcCL, GrpcCLC } from '@dogsvr/cl-grpc';
import * as path from "node:path";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: path.resolve(__dirname, "battlesvr_logic.js"),
    workerThreadNum: 1,
    clMap: { "grpc": new GrpcCL(30001) },
    clcMap: { "zonesvr": new GrpcCLC("127.0.0.1:20001") }
}
dogsvr.startServer(svrCfg);
