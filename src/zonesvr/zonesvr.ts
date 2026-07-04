import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger } from '@dogsvr/logger/main_thread';
import '@dogsvr/cl-tsrpc';
import '@dogsvr/cl-grpc';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';
import { buildLoggerOptions, setupOtelMain } from '../otel/main';

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
setupLogger(buildLoggerOptions('zonesvr'));
setupOtelMain('zonesvr');
(cfg.clMap['tsrpc'] as TsrpcCL).setAuthFunc(async (msg: dogsvr.Msg) => {
    if (!msg.head.openId || !msg.head.zoneId) {
        return false;
    }
    return true;
});
dogsvr.startServer(cfg);
