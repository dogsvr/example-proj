// Worker-thread metrics for example-proj via OpenTelemetry SDK + OTLP HTTP push.

import { PerformanceObserver, monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';
import * as v8 from 'node:v8';
import { metrics, type Counter, type Histogram, type UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, AggregationType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { WorkerMetricSink } from '@dogsvr/dogsvr/worker_thread';
import { DURATION_BUCKETS_MS, TICK_BUCKETS_MS, DEFAULT_OTLP_METRICS_ENDPOINT } from './defaults';

const GC_BUCKETS_SEC = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

const GC_KIND: Record<number, string> = {
    1: 'minor',
    2: 'major',
    4: 'incremental',
    8: 'weak_cb',
    15: 'all',
};

export interface WorkerMetricsCfg {
    enabled: boolean;
    serviceName?: string;
    workerIndex?: number;
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

interface WorkerMetricsInit extends WorkerMetricsCfg {
    otlpEndpoint?: string;
}

let cfg: WorkerMetricsCfg = { enabled: false };
let meterProvider: MeterProvider | null = null;

let mongoOpDuration: Histogram | null = null;
let mongoOpErrorTotal: Counter | null = null;
let redisOpDuration: Histogram | null = null;
let redisOpErrorTotal: Counter | null = null;
let tickDuration: Histogram | null = null;
let roomCount: UpDownCounter | null = null;
let roomClients: UpDownCounter | null = null;
let broadcastBytesTotal: Counter | null = null;
let broadcastMsgsTotal: Counter | null = null;
let logEventsTotal: Counter | null = null;

/** Initialize worker metrics. Idempotent. Call once from worker entry. */
export function initWorkerMetrics(input: WorkerMetricsInit): void {
    cfg = input;
    if (!cfg.enabled) return;

    const exporter = new OTLPMetricExporter({
        url: input.otlpEndpoint ?? DEFAULT_OTLP_METRICS_ENDPOINT,
    });

    meterProvider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': cfg.serviceName ?? 'unknown-worker' }),
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5000 })],
        views: [
            {
                instrumentName: 'mongo_op_duration',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: 'redis_op_duration',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: 'colyseus_tick_duration',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: TICK_BUCKETS_MS } },
            },
            {
                instrumentName: 'dogsvr_worker_gc_duration_seconds',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: GC_BUCKETS_SEC } },
            },
            {
                instrumentName: 'dogsvr_worker_cmd_hdl_duration',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    const meter = metrics.getMeter('@dogsvr/example-proj-worker');
    mongoOpDuration       = meter.createHistogram('mongo_op_duration', { description: 'MongoDB op latency.', unit: 'ms' });
    mongoOpErrorTotal     = meter.createCounter('mongo_op_error_total',   { description: 'MongoDB op errors.' });
    redisOpDuration       = meter.createHistogram('redis_op_duration', { description: 'Redis op latency.', unit: 'ms' });
    redisOpErrorTotal     = meter.createCounter('redis_op_error_total',   { description: 'Redis op errors.' });
    tickDuration          = meter.createHistogram('colyseus_tick_duration', { description: 'Single tick processing time.', unit: 'ms' });
    roomCount             = meter.createUpDownCounter('colyseus_room_count',   { description: 'Active Colyseus rooms.' });
    roomClients           = meter.createUpDownCounter('colyseus_room_clients', { description: 'Connected clients across rooms of a type.' });
    broadcastBytesTotal   = meter.createCounter('colyseus_broadcast', { description: 'Total broadcast bytes.', unit: 'By' });
    broadcastMsgsTotal    = meter.createCounter('colyseus_broadcast_msgs_total',  { description: 'Total broadcast messages.' });
    logEventsTotal        = meter.createCounter('log_events_total',        { description: 'Log events by level.' });

    registerThreadStats(cfg);
    registerCmdHdlStats(cfg);
}

function sampled(rate: number | undefined): boolean {
    if (rate === undefined || rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
}

export async function timeMongoOp<T>(coll: string, op: string, fn: () => Promise<T>): Promise<T> {
    if (!cfg.enabled || !cfg.mongo?.enabled || !sampled(cfg.mongo.samplingRate)) {
        return fn();
    }
    const start = process.hrtime.bigint();
    try {
        const r = await fn();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        mongoOpDuration!.record(ms, { coll, op });
        return r;
    } catch (err) {
        mongoOpErrorTotal!.add(1, { coll, op });
        throw err;
    }
}

export async function timeRedisOp<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (!cfg.enabled || !cfg.redis?.enabled || !sampled(cfg.redis.samplingRate)) {
        return fn();
    }
    const start = process.hrtime.bigint();
    try {
        const r = await fn();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        redisOpDuration!.record(ms, { op });
        return r;
    } catch (err) {
        redisOpErrorTotal!.add(1, { op });
        throw err;
    }
}

export function observeTickDuration(roomType: string, ms: number): void {
    if (!cfg.enabled || !cfg.colyseus?.tickDuration) return;
    tickDuration!.record(ms, { roomType });
}

export function incRoomCount(roomType: string): void {
    if (!cfg.enabled || !cfg.colyseus?.roomCount) return;
    roomCount!.add(1, { roomType });
}

export function decRoomCount(roomType: string): void {
    if (!cfg.enabled || !cfg.colyseus?.roomCount) return;
    roomCount!.add(-1, { roomType });
}

export function incRoomClients(roomType: string, n = 1): void {
    if (!cfg.enabled || !cfg.colyseus?.roomClients) return;
    roomClients!.add(n, { roomType });
}

export function decRoomClients(roomType: string, n = 1): void {
    if (!cfg.enabled || !cfg.colyseus?.roomClients) return;
    roomClients!.add(-n, { roomType });
}

export function recordBroadcast(roomType: string, bytes?: number): void {
    if (!cfg.enabled) return;
    if (cfg.colyseus?.broadcastCount) {
        broadcastMsgsTotal!.add(1, { roomType });
    }
    if (cfg.colyseus?.broadcastBytes && bytes !== undefined) {
        broadcastBytesTotal!.add(bytes, { roomType });
    }
}

export function incLogEvent(level: string): void {
    if (!cfg.enabled || !cfg.logEvents) return;
    logEventsTotal!.add(1, { level });
}

export function isMetricsEnabled(): boolean {
    return cfg.enabled;
}

export async function shutdownWorkerMetrics(): Promise<void> {
    disposeThreadAndCmdHdlStats();
    await meterProvider?.shutdown();
    meterProvider = null;
}

let eventLoopHist: IntervalHistogram | null = null;
let gcObserver: PerformanceObserver | null = null;
let cmdHdlDuration: Histogram | null = null;
let cmdHdlPending: number = 0;
const cmdHdlInFlight = new Map<number, bigint>();
const cmdHdlLabelBase: Record<string, string | number> = {};

function registerThreadStats(cfgIn: WorkerMetricsCfg): void {
    const ts = cfgIn.threadStats;
    if (!ts) return;
    const meter = metrics.getMeter('@dogsvr/example-proj-worker');
    const attrs: Record<string, string | number> = {
        svr: cfgIn.serviceName ?? 'unknown-worker',
        node_thread_id: threadId,
    };
    if (typeof cfgIn.workerIndex === 'number') attrs.worker_index = cfgIn.workerIndex;

    if (ts.heap) {
        meter.createObservableGauge('dogsvr_worker_heap_used_bytes', {
            description: 'V8 heapUsed for this worker isolate.',
            unit: 'By',
        }).addCallback((r) => r.observe(process.memoryUsage().heapUsed, attrs));
        meter.createObservableGauge('dogsvr_worker_heap_total_bytes', {
            description: 'V8 heapTotal for this worker isolate.',
            unit: 'By',
        }).addCallback((r) => r.observe(process.memoryUsage().heapTotal, attrs));
        meter.createObservableGauge('dogsvr_worker_heap_external_bytes', {
            description: 'V8 external memory referenced from JS.',
            unit: 'By',
        }).addCallback((r) => r.observe(process.memoryUsage().external, attrs));
        meter.createObservableGauge('dogsvr_worker_heap_arraybuffers_bytes', {
            description: 'ArrayBuffer memory usage.',
            unit: 'By',
        }).addCallback((r) => r.observe(process.memoryUsage().arrayBuffers, attrs));
        meter.createObservableGauge('dogsvr_worker_heap_limit_bytes', {
            description: 'V8 heap size limit for this worker isolate.',
            unit: 'By',
        }).addCallback((r) => r.observe(v8.getHeapStatistics().heap_size_limit, attrs));
    }

    if (ts.elu) {
        let prevElu = performance.eventLoopUtilization();
        meter.createObservableGauge('dogsvr_worker_elu_utilization', {
            description: 'Event loop utilization over the last observation window (0..1).',
        }).addCallback((r) => {
            const now = performance.eventLoopUtilization(prevElu);
            prevElu = performance.eventLoopUtilization();
            r.observe(now.utilization, attrs);
        });
        eventLoopHist = monitorEventLoopDelay({ resolution: 10 });
        eventLoopHist.enable();
        meter.createObservableGauge('dogsvr_worker_eventloop_lag_seconds', {
            description: 'Event loop lag (mean over the observation window).',
            unit: 's',
        }).addCallback((r) => {
            if (!eventLoopHist) return;
            r.observe(eventLoopHist.mean / 1e9, attrs);
        });
    }

    if (ts.gc) {
        const gcDuration = meter.createHistogram('dogsvr_worker_gc_duration_seconds', {
            description: 'V8 GC pause duration.',
            unit: 's',
        });
        const gcCount = meter.createCounter('dogsvr_worker_gc_count_total', {
            description: 'V8 GC events.',
        });
        gcObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const kindNum = (entry as unknown as { detail?: { kind?: number } }).detail?.kind
                    ?? (entry as unknown as { kind?: number }).kind
                    ?? 0;
                const kind = GC_KIND[kindNum] ?? String(kindNum);
                gcDuration.record(entry.duration / 1000, { ...attrs, kind });
                gcCount.add(1, { ...attrs, kind });
            }
        });
        gcObserver.observe({ entryTypes: ['gc'], buffered: false });
    }
}

function registerCmdHdlStats(cfgIn: WorkerMetricsCfg): void {
    if (!cfgIn.cmdHdl) return;
    const meter = metrics.getMeter('@dogsvr/example-proj-worker');
    const attrs: Record<string, string | number> = {
        svr: cfgIn.serviceName ?? 'unknown-worker',
        node_thread_id: threadId,
    };
    if (typeof cfgIn.workerIndex === 'number') attrs.worker_index = cfgIn.workerIndex;

    cmdHdlLabelBase.svr = attrs.svr;
    cmdHdlLabelBase.node_thread_id = threadId;
    if (typeof cfgIn.workerIndex === 'number') cmdHdlLabelBase.worker_index = cfgIn.workerIndex;
    cmdHdlDuration = meter.createHistogram('dogsvr_worker_cmd_hdl_duration', {
        description: 'Time spent in a worker cmd handler (dispatch to resolve).',
        unit: 'ms',
    });
    meter.createObservableGauge('dogsvr_worker_cmd_hdl_pending', {
        description: 'In-flight cmd handler count for this worker.',
    }).addCallback((r) => r.observe(cmdHdlPending, attrs));
}

function disposeThreadAndCmdHdlStats(): void {
    eventLoopHist?.disable();
    eventLoopHist = null;
    gcObserver?.disconnect();
    gcObserver = null;
    cmdHdlDuration = null;
    cmdHdlInFlight.clear();
    cmdHdlPending = 0;
    for (const k of Object.keys(cmdHdlLabelBase)) delete cmdHdlLabelBase[k];
}
export function createWorkerMetricSink(): WorkerMetricSink {
    return {
        onCmdHdlStart(txnId: number, _cmdId: number): void {
            if (!cmdHdlDuration) return;
            cmdHdlPending++;
            cmdHdlInFlight.set(txnId, process.hrtime.bigint());
        },
        onCmdHdlEnd(txnId: number, cmdId: number, ok: boolean): void {
            if (!cmdHdlDuration) return;
            cmdHdlPending = Math.max(0, cmdHdlPending - 1);
            const startNs = cmdHdlInFlight.get(txnId);
            if (startNs === undefined) return;
            cmdHdlInFlight.delete(txnId);
            const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
            cmdHdlDuration.record(ms, {
                ...cmdHdlLabelBase,
                cmd_id: String(cmdId),
                ok: ok ? '1' : '0',
            });
        },
    };
}

