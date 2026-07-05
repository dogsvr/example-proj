import { workerData } from 'node:worker_threads';
import * as dogsvrWorker from '@dogsvr/dogsvr/worker_thread';
import { type Level } from '@dogsvr/logger/main_thread';
import { setupOtelTracing, shutdownOtelTracing } from './tracing';
import { initWorkerMetrics, shutdownWorkerMetrics, createWorkerMetricSink } from './metrics_worker';
import {
    DEFAULT_OTLP_TRACES_ENDPOINT,
    DEFAULT_OTLP_METRICS_ENDPOINT,
} from './defaults';
import type { WorkerOtelConfigExt } from './config';

interface WorkerCfgWithOtel extends dogsvrWorker.WorkerThreadBaseConfig {
    log: { level: Level };
    otel?: WorkerOtelConfigExt;
}

export function setupOtelWorker(svr: string): void {
    const cfg = dogsvrWorker.getThreadConfig<WorkerCfgWithOtel>();
    const otel = cfg.otel;
    if (otel?.traces?.enabled) {
        const endpoint = otel.traces.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
            ?? DEFAULT_OTLP_TRACES_ENDPOINT;
        setupOtelTracing(
            { serviceName: `${svr}-worker`, otlpEndpoint: endpoint, samplingRate: otel.traces.samplingRate },
            dogsvrWorker.setSpanSink,
        );
        dogsvrWorker.onShutdown(shutdownOtelTracing);
    }
    if (otel?.metrics?.enabled) {
        const endpoint = otel.metrics.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
            ?? DEFAULT_OTLP_METRICS_ENDPOINT;
        const workerIndex = typeof workerData?.workerIndex === 'number' ? workerData.workerIndex : undefined;
        initWorkerMetrics({
            ...otel.metrics,
            otlpEndpoint: endpoint,
            serviceName: `${svr}-worker`,
            workerIndex,
        });
        dogsvrWorker.setWorkerMetricSink(createWorkerMetricSink());
        dogsvrWorker.onShutdown(shutdownWorkerMetrics);
    }
}
