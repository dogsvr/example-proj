// Default OTLP endpoints and shared histogram buckets.

export const DEFAULT_OTLP_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces';
export const DEFAULT_OTLP_LOGS_ENDPOINT   = 'http://localhost:4318/v1/logs';

export const DURATION_BUCKETS_MS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
export const TICK_BUCKETS_MS     = [2, 4, 8, 12, 16.67, 20, 33, 50, 100];
