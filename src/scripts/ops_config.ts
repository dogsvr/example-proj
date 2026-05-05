/**
 * Tiny module-level holder for the ops-script config.
 *
 * `ops.ts` loads the JSON config at startup and calls {@link setOpsConfig};
 * individual commands that need fields other than mongoUri/redisUri (e.g.
 * cfgDbPath for rank:top) read it via {@link getOpsConfig}. We don't pass it
 * through the command signature because 95% of commands don't need it, and a
 * plain OpsContext keeps the common case simple.
 */

export interface OpsConfig {
    mongoUri: string;
    redisUri: string;
    cfgDbPath?: string;       // relative to _configDir
    tableKeysPath?: string;   // relative to _configDir
    /** Absolute directory of the loaded config file, for resolving relative paths. */
    _configDir: string;
}

let current: OpsConfig | null = null;

export function setOpsConfig(cfg: OpsConfig): void {
    current = cfg;
}

export function getOpsConfig(): OpsConfig {
    if (!current) {
        throw new Error('ops config not loaded (did you call ops.ts entry?)');
    }
    return current;
}
