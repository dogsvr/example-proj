// Main-thread metrics for example-proj via OpenTelemetry SDK + OTLP HTTP push.

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, AggregationType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MetricSink } from '@dogsvr/dogsvr/main_thread';
import type { MetricsConfigExt } from './otel_config';
import { DURATION_BUCKETS_MS, TICK_BUCKETS_MS, DEFAULT_OTLP_METRICS_ENDPOINT } from './otel_defaults';

const METRIC_NAMES = {
    cmdDuration:        'dogsvr_cmd_duration',
    txnPending:         'dogsvr_txn_pending',
    txnTimeoutTotal:    'dogsvr_txn_timeout_total',
    workerPending:      'dogsvr_worker_pending',
    tickDuration:       'colyseus_tick_duration',
    redisOpDuration:    'redis_op_duration',
    mongoOpDuration:    'mongo_op_duration',
} as const;

let meterProvider: MeterProvider | null = null;
let eventLoopHist: IntervalHistogram | null = null;

export interface OtelMetricsOptions {
    svr: string;
    metricsConfig: MetricsConfigExt;
    otlpEndpoint?: string;
}

/** Init MeterProvider + OTLP HTTP push exporter + process/nodejs gauges. Returns MetricSink for dogsvr. */
export function setupOtelMetrics(opts: OtelMetricsOptions): MetricSink {
    if (meterProvider) {
        throw new Error('setupOtelMetrics already called');
    }

    const exporter = new OTLPMetricExporter({
        url: opts.otlpEndpoint ?? DEFAULT_OTLP_METRICS_ENDPOINT,
    });

    meterProvider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': opts.svr }),
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5000 })],
        views: [
            {
                instrumentName: METRIC_NAMES.cmdDuration,
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: METRIC_NAMES.tickDuration,
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: TICK_BUCKETS_MS } },
            },
            {
                instrumentName: METRIC_NAMES.redisOpDuration,
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: METRIC_NAMES.mongoOpDuration,
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    registerDefaultMetrics(opts.svr);

    return createMetricSink(opts.svr, opts.metricsConfig);
}

function registerDefaultMetrics(svr: string): void {
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const attrs = { svr, role: 'main' };

    meter.createObservableCounter('process_cpu_time', {
        description: 'CPU time consumed by the process (user+system).',
        unit: 's',
    }).addCallback((result) => {
        const u = process.cpuUsage();
        result.observe((u.user + u.system) / 1e6, attrs);
    });

    meter.createObservableGauge('process_resident_memory', {
        description: 'Resident memory size of the process.',
        unit: 'By',
    }).addCallback((result) => {
        result.observe(process.memoryUsage().rss, attrs);
    });

    meter.createObservableGauge('process_heap', {
        description: 'Used heap size.',
        unit: 'By',
    }).addCallback((result) => {
        result.observe(process.memoryUsage().heapUsed, attrs);
    });

    eventLoopHist = monitorEventLoopDelay({ resolution: 10 });
    eventLoopHist.enable();
    meter.createObservableGauge('nodejs_eventloop_lag', {
        description: 'Event loop lag (mean over the sampling window).',
        unit: 's',
    }).addCallback((result) => {
        if (!eventLoopHist) return;
        result.observe(eventLoopHist.mean / 1e9, attrs);
    });
}

interface InFlightCmd {
    cmdId: string;
    startNs: bigint;
}

function createMetricSink(svr: string, cfg: MetricsConfigExt): MetricSink {
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const cmdDuration = meter.createHistogram(METRIC_NAMES.cmdDuration, {
        description: 'Time from main-thread dispatch to worker reply.',
        unit: 'ms',
    });
    const txnPending = meter.createGauge(METRIC_NAMES.txnPending, {
        description: 'Pending transactions in TxnMgr (sampled).',
    });
    const txnTimeoutTotal = meter.createCounter(METRIC_NAMES.txnTimeoutTotal, {
        description: 'Total transaction timeouts.',
    });
    const workerPending = meter.createGauge(METRIC_NAMES.workerPending, {
        description: 'In-flight requests per worker thread (sampled).',
    });

    const inFlight = new Map<number, InFlightCmd>();
    const sampleRate = cfg.samplingRate ?? 1.0;

    return {
        onCmdStart(txnId: number, cmdId: string, _workerIndex: number): void {
            if (!cfg.cmdDuration) return;
            if (sampleRate < 1.0 && Math.random() >= sampleRate) return;
            inFlight.set(txnId, { cmdId, startNs: process.hrtime.bigint() });
        },
        onCmdEnd(txnId: number, _workerIndex: number, ok: boolean): void {
            const ctx = inFlight.get(txnId);
            if (!ctx) return;
            inFlight.delete(txnId);
            const ms = Number(process.hrtime.bigint() - ctx.startNs) / 1e6;
            cmdDuration.record(ms, { svr, cmdId: ctx.cmdId, ok: ok ? '1' : '0' });
        },
        onTxnTimeout(txnId: number, _workerIndex: number): void {
            inFlight.delete(txnId);
            txnTimeoutTotal.add(1, { svr });
        },
        observeTxnPending(count: number): void {
            if (!cfg.txnPending) return;
            txnPending.record(count, { svr });
        },
        observeWorkerPending(perWorker: readonly number[]): void {
            if (!cfg.workerPending) return;
            for (let i = 0; i < perWorker.length; i++) {
                workerPending.record(perWorker[i], { svr, worker: String(i) });
            }
        },
    };
}

export async function shutdownOtelMetrics(): Promise<void> {
    eventLoopHist?.disable();
    eventLoopHist = null;
    await meterProvider?.shutdown();
    meterProvider = null;
}
