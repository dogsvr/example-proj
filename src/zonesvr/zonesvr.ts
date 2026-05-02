import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-tsrpc';
import '@dogsvr/cl-grpc';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
(cfg.clMap['tsrpc'] as TsrpcCL).setAuthFunc(async (msg: dogsvr.Msg) => {
    // zonesvr requires authenticated identity: openId + zoneId must be present
    if (!msg.head.openId || !msg.head.zoneId) {
        return false;
    }
    return true;
});
dogsvr.startServer(cfg);
