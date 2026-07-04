import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { type SetupOptions, type OtelLogsOptions } from '@dogsvr/logger/main_thread';
import { setupOtelMetrics, shutdownOtelMetrics } from './metrics_main';
import { setupOtelTracing, shutdownOtelTracing } from './tracing';
import {
    DEFAULT_OTLP_TRACES_ENDPOINT,
    DEFAULT_OTLP_LOGS_ENDPOINT,
    DEFAULT_OTLP_METRICS_ENDPOINT,
} from './defaults';
import type { OtelConfigExt } from './config';

interface MainCfgWithOtel extends dogsvr.MainThreadJsonConfig {
    log: SetupOptions;
    otel?: OtelConfigExt;
}

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

export function setupOtelMain(svr: string): void {
    const raw = dogsvr.getMainThreadConfig<MainCfgWithOtel>();
    const otel = raw.otel;
    if (otel?.traces?.enabled) {
        const endpoint = otel.traces.endpoint
            ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
            ?? DEFAULT_OTLP_TRACES_ENDPOINT;
        setupOtelTracing(
            { serviceName: svr, otlpEndpoint: endpoint, samplingRate: otel.traces.samplingRate },
            dogsvr.setSpanSink,
        );
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
