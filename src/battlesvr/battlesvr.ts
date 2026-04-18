import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-grpc';

dogsvr.startServer(__dirname + '/main_thread_config.json');
