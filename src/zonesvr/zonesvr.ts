import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';
import { GrpcCL, GrpcCLC } from '@dogsvr/cl-grpc';

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const connLayer: TsrpcCL = new TsrpcCL("ws", 2000);
connLayer.setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: "./zonesvr_logic.js",
    workerThreadNum: 2,
    clMap: { "tsrpc": connLayer, "grpc": new GrpcCL(2001) },
    clcMap: { "battlesvr": new GrpcCLC("127.0.0.1:3001") }
}
dogsvr.startServer(svrCfg);
