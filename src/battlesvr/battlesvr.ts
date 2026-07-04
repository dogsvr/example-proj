import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger } from '@dogsvr/logger/main_thread';
import '@dogsvr/cl-grpc';
import { buildLoggerOptions, setupOtelMain } from '../otel/main';

const cfg = dogsvr.loadMainThreadConfig(__dirname + '/main_thread_config.json');
setupLogger(buildLoggerOptions('battlesvr'));
setupOtelMain('battlesvr');
dogsvr.startServer(cfg);
