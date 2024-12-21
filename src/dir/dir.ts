import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';
import * as path from "node:path";

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const connLayer: TsrpcCL = new TsrpcCL("http", 10000);
connLayer.setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: path.resolve(__dirname, "dir_logic.js"),
    workerThreadNum: 2,
    clMap: { "tsrpc": connLayer },
    clcMap: {}
}
dogsvr.startServer(svrCfg);
