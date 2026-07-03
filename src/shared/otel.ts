// Business-side wiring for the three otel signals (metrics, traces, logs).

import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import * as dogsvrWorker from '@dogsvr/dogsvr/worker_thread';
import { type SetupOptions, type OtelLogsOptions, type Level } from '@dogsvr/logger/main_thread';
import { setupOtelMetrics, shutdownOtelMetrics } from './otel_metrics';
import { setupOtelTracingMain, setupOtelTracingWorker, shutdownOtelTracing } from './otel_tracing';
import { initWorkerMetrics, shutdownWorkerMetrics } from './otel_metrics_worker';
import {
    DEFAULT_OTLP_TRACES_ENDPOINT,
    DEFAULT_OTLP_LOGS_ENDPOINT,
    DEFAULT_OTLP_METRICS_ENDPOINT,
} from './otel_defaults';
import type { OtelConfigExt, WorkerOtelConfigExt } from './otel_config';

interface MainCfgWithOtel extends dogsvr.MainThreadJsonConfig {
    log: SetupOptions;
    otel?: OtelConfigExt;
}

interface WorkerCfgWithOtel extends dogsvrWorker.WorkerThreadBaseConfig {
    log: { level: Level };
    otel?: WorkerOtelConfigExt;
}

/** Produce SetupOptions from main-thread config. No side effects. */
export function buildLoggerOptions(svr: string): SetupOptions {
    const raw = dogsvr.getMainThreadConfig<MainCfgWithOtel>();
    const otelLogsCfg = raw.otel?.logs;
    const otel: OtelLogsOptions | undefined = otelLogsCfg?.enabled
        ? {
            enabled: true,
            otlpEndpoint: otelLogsCfg.endpoint
                ?? process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
                ?? DEFAULT_OTLP_LOGS_ENDPOINT,
            serviceName: svr,
            level: otelLogsCfg.level,
        }
        : undefined;
    return {
        ...raw.log,
        base: { svrId: svr },
        otel,
    };
}

/** Wire main-thread metrics + traces from cfg.otel. */
export function setupOtelMain(svr: string): void {
    const raw = dogsvr.getMainThreadConfig<MainCfgWithOtel>();
    const otel = raw.otel;
    if (otel?.traces?.enabled) {
        const endpoint = otel.traces.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
            ?? DEFAULT_OTLP_TRACES_ENDPOINT;
        setupOtelTracingMain({ serviceName: svr, otlpEndpoint: endpoint, samplingRate: otel.traces.samplingRate });
        dogsvr.onShutdown(shutdownOtelTracing);
    }
    if (otel?.metrics?.enabled) {
        const endpoint = otel.metrics.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
            ?? DEFAULT_OTLP_METRICS_ENDPOINT;
        dogsvr.setMetricSink(setupOtelMetrics({
            svr,
            metricsConfig: otel.metrics,
            otlpEndpoint: endpoint,
        }));
        dogsvr.onShutdown(shutdownOtelMetrics);
    }
}

/** Wire worker-thread metrics + traces from cfg.otel. */
export function setupOtelWorker(svr: string): void {
    const cfg = dogsvrWorker.getThreadConfig<WorkerCfgWithOtel>();
    const otel = cfg.otel;
    if (otel?.traces?.enabled) {
        const endpoint = otel.traces.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
            ?? DEFAULT_OTLP_TRACES_ENDPOINT;
        setupOtelTracingWorker({ serviceName: `${svr}-worker`, otlpEndpoint: endpoint, samplingRate: otel.traces.samplingRate });
        dogsvrWorker.onShutdown(shutdownOtelTracing);
    }
    if (otel?.metrics?.enabled) {
        const endpoint = otel.metrics.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
            ?? DEFAULT_OTLP_METRICS_ENDPOINT;
        initWorkerMetrics({
            ...otel.metrics,
            otlpEndpoint: endpoint,
            serviceName: `${svr}-worker`,
        });
        dogsvrWorker.onShutdown(shutdownWorkerMetrics);
    }
}
