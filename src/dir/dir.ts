import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-tsrpc';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
// dir accepts anonymous requests (e.g. registration before a user has an openId),
// so no openId/zoneId check here.
(cfg.clMap['tsrpc'] as TsrpcCL).setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});
dogsvr.startServer(cfg);
