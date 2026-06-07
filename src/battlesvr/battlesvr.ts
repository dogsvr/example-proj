import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger, type SetupOptions } from '@dogsvr/logger/main_thread';
import '@dogsvr/cl-grpc';

interface BattleSvrMainConfig extends dogsvr.MainThreadJsonConfig {
    log: SetupOptions;
}

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
setupLogger({
    ...dogsvr.getMainThreadConfig<BattleSvrMainConfig>().log,
    base: { svrId: 'battlesvr' },
});
dogsvr.startServer(cfg);
