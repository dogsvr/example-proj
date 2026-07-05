// Business-side OTel config schema — extends framework-side OtelConfig with OTLP details.

import type { MetricsConfig, TraceConfig, LogConfig } from '@dogsvr/dogsvr/main_thread';
import type { Level } from '@dogsvr/logger/main_thread';

export interface MetricsConfigExt extends MetricsConfig {
    /** OTLP/HTTP endpoint. Falls back to OTEL_EXPORTER_OTLP_METRICS_ENDPOINT then DEFAULT_OTLP_METRICS_ENDPOINT. */
    endpoint?: string;
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
    /** OTLP-sink minimum level. Independent of cfg.log.level. Defaults to cfg.log.level. */
    level?: Level;
}

export interface OtelConfigExt {
    metrics?: MetricsConfigExt;
    traces?:  TraceConfigExt;
    logs?:    LogConfigExt;
}

export interface WorkerMetricsCfg {
    enabled: boolean;
    /** OTLP/HTTP endpoint. Falls back to OTEL_EXPORTER_OTLP_METRICS_ENDPOINT then DEFAULT_OTLP_METRICS_ENDPOINT. */
    endpoint?: string;
    mongo?: { enabled: boolean; samplingRate?: number };
    redis?: { enabled: boolean; samplingRate?: number };
    colyseus?: {
        tickDuration?: boolean;
        roomCount?: boolean;
        roomClients?: boolean;
        broadcastBytes?: boolean;
        broadcastCount?: boolean;
    };
    logEvents?: boolean;
    threadStats?: {
        heap?: boolean;
        elu?: boolean;
        gc?: boolean;
    };
    cmdHdl?: boolean;
}

/** Worker has no logs sub-block; logger init flows through workerData.loggerInit. */
export interface WorkerOtelConfigExt {
    metrics?: WorkerMetricsCfg;
    traces?:  TraceConfigExt;
}
