import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';
import { GrpcCL, GrpcCLC } from '@dogsvr/cl-grpc';
import * as path from "node:path";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const connLayer: TsrpcCL = new TsrpcCL("ws", 20000);
connLayer.setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: path.resolve(__dirname, "zonesvr_logic.js"),
    workerThreadNum: 2,
    clMap: { "tsrpc": connLayer, "grpc": new GrpcCL(20001) },
    clcMap: { "battlesvr": new GrpcCLC("127.0.0.1:30001") }
}
dogsvr.startServer(svrCfg);
