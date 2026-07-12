import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, AggregationType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
    getLatestThreadStatsSnapshot,
    getTxnPendingCount,
    getWorkerPendingCounts,
    getMsgChannelStats,
    type MetricSink,
} from '@dogsvr/dogsvr/main_thread';
import type { MetricsConfigExt } from './config';
import { DURATION_BUCKETS_MS } from './defaults';

const METRIC_NAMES = {
    cmdDuration:            'dogsvr_cmd_duration',
    txnPending:             'dogsvr_txn_pending',
    txnTimeoutTotal:        'dogsvr_txn_timeout_total',
    workerPending:          'dogsvr_worker_pending',
    msgChannelSabHits:      'dogsvr_msg_channel_sab_hits_total',
    msgChannelFallback:     'dogsvr_msg_channel_fallback_total',
    threadCpuTime:          'dogsvr_thread_cpu_time_seconds_total',
    threadCpuWait:          'dogsvr_thread_cpu_wait_seconds_total',
    threadCpuUtilization:   'dogsvr_thread_cpu_utilization',
    processThreadCount:     'dogsvr_process_thread_count',
    processRssBytes:        'dogsvr_process_rss_bytes',
    processVszBytes:        'dogsvr_process_vsz_bytes',
} as const;

let meterProvider: MeterProvider | null = null;
let eventLoopHist: IntervalHistogram | null = null;

interface MainMetricsInit extends MetricsConfigExt {
    svr: string;
    endpoint: string;
}

export function setupOtelMetrics(input: MainMetricsInit): MetricSink {
    if (meterProvider) {
        throw new Error('setupOtelMetrics already called');
    }

    const exporter = new OTLPMetricExporter({
        url: input.endpoint,
    });

    meterProvider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': input.svr }),
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5000 })],
        views: [
            {
                instrumentName: METRIC_NAMES.cmdDuration,
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    registerDefaultMetrics(input.svr);
    registerPendingMetrics(input);
    registerMsgChannelMetrics(input);
    registerThreadStatsMetrics(input);

    return createMetricSink(input);
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
        description: 'Resident memory size of the process (legacy name; see also dogsvr_process_rss_bytes).',
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
        // reset() → per-scrape window; forfeits percentiles/stddev/max from this instance.
        eventLoopHist.reset();
    });
}

function registerPendingMetrics(input: MainMetricsInit): void {
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const svr = input.svr;

    if (input.txnPending) {
        meter.createObservableGauge(METRIC_NAMES.txnPending, {
            description: 'Pending transactions in TxnMgr.',
        }).addCallback((r) => r.observe(getTxnPendingCount(), { svr }));
    }

    if (input.workerPending) {
        meter.createObservableGauge(METRIC_NAMES.workerPending, {
            description: 'In-flight requests per worker thread.',
        }).addCallback((r) => {
            const perWorker = getWorkerPendingCounts();
            for (let i = 0; i < perWorker.length; i++) {
                r.observe(perWorker[i], { svr, worker_index: i });
            }
        });
    }
}

function registerMsgChannelMetrics(input: MainMetricsInit): void {
    if (input.msgChannel === false) return;
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const svr = input.svr;

    const sabHits = meter.createObservableCounter(METRIC_NAMES.msgChannelSabHits, {
        description: 'Main→worker Msg frames written to SAB ring buffer.',
    });
    const fallback = meter.createObservableCounter(METRIC_NAMES.msgChannelFallback, {
        description: 'Main→worker Msg frames that fell back to postMessage (SAB full or disabled).',
    });

    meter.addBatchObservableCallback((observer) => {
        for (const s of getMsgChannelStats()) {
            const attrs = { svr, worker_index: s.workerIndex, side: 'main' };
            observer.observe(sabHits, s.sabHits, attrs);
            observer.observe(fallback, s.fallbackHits, attrs);
        }
    }, [sabHits, fallback]);
}

function registerThreadStatsMetrics(input: MainMetricsInit): void {
    if (!input.threadStats?.enabled) return;
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const svr = input.svr;

    const cpuTime = meter.createObservableCounter(METRIC_NAMES.threadCpuTime, {
        description: 'Cumulative CPU run time per thread.',
        unit: 's',
    });
    const cpuWait = meter.createObservableCounter(METRIC_NAMES.threadCpuWait, {
        description: 'Cumulative CPU runqueue-wait time per thread.',
        unit: 's',
    });
    const cpuUtil = meter.createObservableGauge(METRIC_NAMES.threadCpuUtilization, {
        description: 'Per-thread CPU utilization (Δrun / Δwall); 1.0 = one core saturated.',
    });
    const threadCount = meter.createObservableUpDownCounter(METRIC_NAMES.processThreadCount, {
        description: 'Total OS-level thread count for the process.',
    });
    const rssGauge = meter.createObservableGauge(METRIC_NAMES.processRssBytes, {
        description: 'Resident set size of the process.',
        unit: 'By',
    });
    const vszGauge = meter.createObservableGauge(METRIC_NAMES.processVszBytes, {
        description: 'Virtual memory size of the process.',
        unit: 'By',
    });

    meter.addBatchObservableCallback((observer) => {
        const snap = getLatestThreadStatsSnapshot();
        if (!snap) return;
        for (const s of snap.samples) {
            const attrs: Record<string, string | number> = {
                svr,
                thread_role: s.role,
                tid: s.osTid,
            };
            if (s.workerIndex !== null) attrs.worker_index = s.workerIndex;
            if (s.nodeThreadId !== null) attrs.node_thread_id = s.nodeThreadId;
            observer.observe(cpuTime, s.cpuTimeSec, attrs);
            if (s.cpuWaitSec !== undefined) observer.observe(cpuWait, s.cpuWaitSec, attrs);
            if (s.cpuUtilization !== null) observer.observe(cpuUtil, s.cpuUtilization, attrs);
        }
        observer.observe(threadCount, snap.process.threadCount, { svr });
        observer.observe(rssGauge, snap.process.rssBytes, { svr });
        observer.observe(vszGauge, snap.process.vszBytes, { svr });
    }, [cpuTime, cpuWait, cpuUtil, threadCount, rssGauge, vszGauge]);
}

interface InFlightCmd {
    cmdId: number;
    startNs: bigint;
}

function createMetricSink(input: MainMetricsInit): MetricSink {
    const meter = metrics.getMeter('@dogsvr/example-proj');
    const svr = input.svr;
    const cmdDuration = meter.createHistogram(METRIC_NAMES.cmdDuration, {
        description: 'Time from main-thread dispatch to worker reply.',
        unit: 'ms',
    });
    const txnTimeoutTotal = meter.createCounter(METRIC_NAMES.txnTimeoutTotal, {
        description: 'Total transaction timeouts.',
    });

    const inFlight = new Map<number, InFlightCmd>();
    const sampleRate = input.samplingRate ?? 1.0;

    return {
        onCmdStart(txnId: number, cmdId: number): void {
            if (!input.cmdDuration) return;
            if (sampleRate < 1.0 && Math.random() >= sampleRate) return;
            inFlight.set(txnId, { cmdId, startNs: process.hrtime.bigint() });
        },
        onCmdEnd(txnId: number, ok: boolean): void {
            const ctx = inFlight.get(txnId);
            if (!ctx) return;
            inFlight.delete(txnId);
            const ms = Number(process.hrtime.bigint() - ctx.startNs) / 1e6;
            cmdDuration.record(ms, { svr, cmdId: String(ctx.cmdId), ok: ok ? '1' : '0' });
        },
        onTxnTimeout(txnId: number): void {
            inFlight.delete(txnId);
            txnTimeoutTotal.add(1, { svr });
        },
    };
}

export async function shutdownOtelMetrics(): Promise<void> {
    eventLoopHist?.disable();
    eventLoopHist = null;
    await meterProvider?.shutdown();
    meterProvider = null;
}
