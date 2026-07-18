import * as fs from 'node:fs';
import * as path from 'node:path';
import * as inspector from 'node:inspector';
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import Pyroscope from '@pyroscope/nodejs';
import type { ProfilingConfig } from './config';
import { PROFILE_BROADCAST_START, PROFILE_BROADCAST_STOP } from './config';
import {
    DEFAULT_PYROSCOPE_ENDPOINT,
    DEFAULT_SAMPLING_INTERVAL_MICROS,
    DEFAULT_APP_NAME,
    DEFAULT_ON_DEMAND_TIMEOUT_MS,
    CPUPROFILE_DUMP_DIR,
} from './defaults';

interface MainCfgWithProfiling extends dogsvr.MainThreadJsonConfig {
    profiling?: ProfilingConfig;
}

let session: inspector.Session | null = null;
let profileTimer: NodeJS.Timeout | null = null;
let profiling = false;
let profileSvr = '';

export function setupProfileMain(svr: string): void {
    const raw = dogsvr.getMainThreadConfig<MainCfgWithProfiling>();
    const cfg = raw.profiling;
    profileSvr = svr;

    if (cfg?.enabled) {
        const endpoint = cfg.endpoint
            ?? process.env.PYROSCOPE_SERVER_ADDRESS
            ?? DEFAULT_PYROSCOPE_ENDPOINT;
        Pyroscope.init({
            appName: cfg.appName ?? DEFAULT_APP_NAME,
            serverAddress: endpoint,
            wall: {
                samplingIntervalMicros: cfg.samplingIntervalMicros ?? DEFAULT_SAMPLING_INTERVAL_MICROS,
                collectCpuTime: true,
            },
            tags: {
                service_name: svr,
                thread: 'main',
                ...(cfg.extraTags ?? {}),
            },
        });
        Pyroscope.start();
        dogsvr.onShutdown(async () => { await Pyroscope.stop(); });
    }

    process.on('SIGUSR2', onSigusr2);
}

function onSigusr2(): void {
    const starting = !profiling;
    if (starting) {
        void startProfile();
    } else {
        void stopAndDump();
    }
    dogsvr.broadcastToWorkers({
        __dogsvrBroadcast: true,
        type: starting ? PROFILE_BROADCAST_START : PROFILE_BROADCAST_STOP,
    });
}

async function startProfile(): Promise<void> {
    if (profiling) return;
    profiling = true;
    session = new inspector.Session();
    session.connect();
    await new Promise<void>((resolve, reject) => {
        session!.post('Profiler.enable', (err) => err ? reject(err) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
        session!.post('Profiler.start', (err) => err ? reject(err) : resolve());
    });
    profileTimer = setTimeout(() => { void stopAndDump(); }, DEFAULT_ON_DEMAND_TIMEOUT_MS);
}

async function stopAndDump(): Promise<void> {
    if (!profiling || !session) return;
    profiling = false;
    if (profileTimer) { clearTimeout(profileTimer); profileTimer = null; }
    const s = session;
    session = null;
    const profile = await new Promise<inspector.Profiler.Profile>((resolve, reject) => {
        s.post('Profiler.stop', (err, { profile }) => err ? reject(err) : resolve(profile));
    });
    s.disconnect();
    writeProfileFile(profile);
}

function writeProfileFile(profile: inspector.Profiler.Profile): void {
    const dir = path.join(process.cwd(), CPUPROFILE_DUMP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${profileSvr}-${process.pid}-main-${ts}.cpuprofile`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(profile));
}
