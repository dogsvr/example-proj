// Business-side OTel config schema — extends framework-side OtelConfig with OTLP details.

import type { MetricsConfig, TraceConfig, LogConfig } from '@dogsvr/dogsvr/main_thread';
import type { WorkerMetricsCfg } from './otel_metrics_worker';

export interface MetricsConfigExt extends MetricsConfig {
    /** PrometheusExporter port for the main-thread MeterProvider. */
    port?: number;
    cmdDuration?: boolean;
    txnPending?: boolean;
    workerPending?: boolean;
    /** Sampling rate for cmd timing. Default 1.0. */
    samplingRate?: number;
}

export interface TraceConfigExt extends TraceConfig {
    /** OTLP/HTTP endpoint. Falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT then DEFAULT_OTLP_TRACES_ENDPOINT. */
    endpoint?: string;
    samplingRate?: number;
}

export interface LogConfigExt extends LogConfig {
    /** OTLP/HTTP endpoint. Falls back to OTEL_EXPORTER_OTLP_LOGS_ENDPOINT then DEFAULT_OTLP_LOGS_ENDPOINT. */
    endpoint?: string;
}

export interface OtelConfigExt {
    metrics?: MetricsConfigExt;
    traces?:  TraceConfigExt;
    logs?:    LogConfigExt;
}

/** Worker has no logs sub-block; logger init flows through workerData.loggerInit. */
export interface WorkerOtelConfigExt {
    metrics?: WorkerMetricsCfg & { portBase?: number };
    traces?:  TraceConfigExt;
}
