import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger, type SetupOptions } from '@dogsvr/logger/main_thread';
import '@dogsvr/cl-tsrpc';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';

interface DirMainConfig extends dogsvr.MainThreadJsonConfig {
    log: SetupOptions;
}

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
setupLogger({
    ...dogsvr.getMainThreadConfig<DirMainConfig>().log,
    base: { svrId: 'dir' },
});
// dir accepts anonymous requests (e.g. registration before a user has an openId),
// so no openId/zoneId check here.
(cfg.clMap['tsrpc'] as TsrpcCL).setAuthFunc(async (msg: dogsvr.Msg) => {
    return true;
});
dogsvr.startServer(cfg);
