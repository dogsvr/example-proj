export interface ProfilingConfig {
    enabled: boolean;
    /** Pyroscope server address. Falls back to PYROSCOPE_SERVER_ADDRESS env then DEFAULT_PYROSCOPE_ENDPOINT. */
    endpoint?: string;
    /** Sampling interval in microseconds. 10000 == 100Hz. */
    samplingIntervalMicros?: number;
    /** Application name for Pyroscope. Per-service is distinguished via `service_name` tag, not appName. */
    appName?: string;
    /** Extra tags merged into every profile. */
    extraTags?: Record<string, string>;
}

/** Envelope contract for on-demand profile broadcast (main → workers). */
export const PROFILE_BROADCAST_START = 'profile.start';
export const PROFILE_BROADCAST_STOP = 'profile.stop';
