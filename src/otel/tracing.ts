import { context, propagation, trace, type Context, type Span, type SpanContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { SpanSink, SpanCtx, SpanHandle } from '@dogsvr/dogsvr/main_thread';
import type { TraceConfigExt } from './config';

const TRACER_NAME = '@dogsvr/example-proj';

let tracerProvider: NodeTracerProvider | null = null;

export interface OtelTracingOptions extends TraceConfigExt {
    serviceName: string;
    endpoint: string;
    resourceAttributes?: Record<string, string>;
}

function buildProvider(opts: OtelTracingOptions): NodeTracerProvider {
    const exporter = new OTLPTraceExporter({ url: opts.endpoint });
    const rate = opts.samplingRate ?? 1.0;
    const root = rate >= 1.0
        ? new AlwaysOnSampler()
        : new TraceIdRatioBasedSampler(Math.max(0, Math.min(1, rate)));
    return new NodeTracerProvider({
        resource: resourceFromAttributes({
            'service.name': opts.serviceName,
            ...(opts.resourceAttributes ?? {}),
        }),
        sampler: new ParentBasedSampler({ root }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
    });
}

function buildSink(): SpanSink {
    const tracer = trace.getTracer(TRACER_NAME);
    const propagator = new W3CTraceContextPropagator();

    function wrap(span: Span): SpanHandle {
        const sc = span.spanContext();
        const ctx: SpanCtx = {
            traceId: sc.traceId,
            spanId: sc.spanId,
            traceFlags: sc.traceFlags,
            traceState: sc.traceState?.serialize(),
        };
        return {
            setAttribute: (k, v) => { span.setAttribute(k, v); },
            recordException: (err) => {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
            },
            end: (ok) => {
                if (!ok) span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            },
            context: () => ctx,
        };
    }

    return {
        start(name, parent, attrs) {
            let parentCtx: Context = context.active();
            if (parent) {
                const sc: SpanContext = {
                    traceId: parent.traceId,
                    spanId: parent.spanId,
                    traceFlags: parent.traceFlags,
                    isRemote: true,
                };
                parentCtx = trace.setSpanContext(parentCtx, sc);
            }
            const span = tracer.startSpan(
                name,
                { kind: SpanKind.SERVER, attributes: attrs },
                parentCtx,
            );
            return wrap(span);
        },
        extract(carrier) {
            const clean: Record<string, string> = {};
            for (const k of Object.keys(carrier)) {
                const v = carrier[k];
                if (typeof v === 'string') clean[k] = v;
            }
            const ctx = propagator.extract(context.active(), clean, {
                get: (c, k) => c[k],
                keys: (c) => Object.keys(c),
            });
            const sc = trace.getSpanContext(ctx);
            if (!sc) return null;
            return {
                traceId: sc.traceId,
                spanId: sc.spanId,
                traceFlags: sc.traceFlags,
                traceState: sc.traceState?.serialize(),
            };
        },
        inject(span, carrier) {
            const spanCtx = 'context' in span ? span.context() : span;
            const sc: SpanContext = {
                traceId: spanCtx.traceId,
                spanId: spanCtx.spanId,
                traceFlags: spanCtx.traceFlags,
                isRemote: false,
            };
            const ctx = trace.setSpanContext(context.active(), sc);
            propagator.inject(ctx, carrier, {
                set: (c, k, v) => { c[k] = v; },
            });
        },
        getCurrent() {
            const span = trace.getActiveSpan();
            if (!span) return null;
            return wrap(span);
        },
        getCurrentContext() {
            const span = trace.getActiveSpan();
            if (!span) return null;
            const sc = span.spanContext();
            return {
                traceId: sc.traceId,
                spanId: sc.spanId,
                traceFlags: sc.traceFlags,
                traceState: sc.traceState?.serialize(),
            };
        },
        withActive(span, fn) {
            const sc: SpanContext = {
                traceId: span.context().traceId,
                spanId: span.context().spanId,
                traceFlags: span.context().traceFlags,
                isRemote: false,
            };
            const ctx = trace.setSpanContext(context.active(), sc);
            return context.with(ctx, fn);
        },
    };
}

function commonSetup(opts: OtelTracingOptions): SpanSink {
    if (tracerProvider) {
        throw new Error('otel tracing already set up in this process');
    }
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    tracerProvider = buildProvider(opts);
    trace.setGlobalTracerProvider(tracerProvider);
    return buildSink();
}

export function setupOtelTracing(
    opts: OtelTracingOptions,
    setSpanSink: (sink: SpanSink) => void,
): void {
    setSpanSink(commonSetup(opts));
}

export async function shutdownOtelTracing(): Promise<void> {
    await tracerProvider?.shutdown();
    tracerProvider = null;
}
