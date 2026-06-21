// Worker-thread metrics for example-proj via OpenTelemetry SDK + PrometheusExporter.

import { metrics, type Counter, type Histogram, type UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, AggregationType } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { DURATION_BUCKETS_MS, TICK_BUCKETS_MS } from './otel_defaults';

export interface WorkerMetricsCfg {
    enabled: boolean;
    port?: number;
    serviceName?: string;
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
export function initWorkerMetrics(input: WorkerMetricsCfg): void {
    cfg = input;
    if (!cfg.enabled) return;

    const exporter = new PrometheusExporter({
        host: '127.0.0.1',
        port: cfg.port ?? 0,
        endpoint: '/metrics',
        appendTimestamp: false,
    });

    meterProvider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': cfg.serviceName ?? 'unknown-worker' }),
        readers: [exporter],
        views: [
            {
                instrumentName: 'mongo_op_duration_ms',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: 'redis_op_duration_ms',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_MS } },
            },
            {
                instrumentName: 'colyseus_tick_duration_ms',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: TICK_BUCKETS_MS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    const meter = metrics.getMeter('@dogsvr/example-proj-worker');
    mongoOpDuration       = meter.createHistogram('mongo_op_duration_ms', { description: 'MongoDB op latency.', unit: 'ms' });
    mongoOpErrorTotal     = meter.createCounter('mongo_op_error_total',   { description: 'MongoDB op errors.' });
    redisOpDuration       = meter.createHistogram('redis_op_duration_ms', { description: 'Redis op latency.', unit: 'ms' });
    redisOpErrorTotal     = meter.createCounter('redis_op_error_total',   { description: 'Redis op errors.' });
    tickDuration          = meter.createHistogram('colyseus_tick_duration_ms', { description: 'Single tick processing time.', unit: 'ms' });
    roomCount             = meter.createUpDownCounter('colyseus_room_count',   { description: 'Active Colyseus rooms.' });
    roomClients           = meter.createUpDownCounter('colyseus_room_clients', { description: 'Connected clients across rooms of a type.' });
    broadcastBytesTotal   = meter.createCounter('colyseus_broadcast_bytes_total', { description: 'Total broadcast bytes.', unit: 'By' });
    broadcastMsgsTotal    = meter.createCounter('colyseus_broadcast_msgs_total',  { description: 'Total broadcast messages.' });
    logEventsTotal        = meter.createCounter('log_events_total',        { description: 'Log events by level.' });
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
    await meterProvider?.shutdown();
    meterProvider = null;
}
