import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';

dogsvr.setLogLevel(dogsvr.LOG_LEVEL_TRACE);

const connLayer: TsrpcCL = new TsrpcCL(2000);
connLayer.setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});

const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: "./zonesvr_logic.js",
    workerThreadNum: 2,
    connLayer: connLayer,
}
dogsvr.startServer(svrCfg);
