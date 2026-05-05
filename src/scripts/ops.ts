/**
 * `npm run ops -- <command> [options]`
 *
 * The example-proj ops CLI. Reads zonesvr's worker_thread_config.json (same
 * mongoUri + redisUri the live zonesvr uses), opens one Mongo + one Redis
 * connection, and dispatches to the command registered under `name`.
 *
 * Run via tsx (see package.json "ops" script) — no build step required. This
 * is intentional: ops scripts should be editable live, with the same TS error
 * surface as the rest of the codebase.
 *
 * Config resolution order:
 *   1. `--config <path>` flag (absolute or relative to cwd)
 *   2. Default: src/zonesvr/worker_thread_config.json relative to this file
 *
 * We do NOT reach into the dogsvr loadWorkerThreadConfig() plumbing — that
 * pathway is worker-specific and pulls in main-thread IPC. A plain
 * `fs.readFile + JSON.parse` does the job and keeps the script dogsvr-free.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MongoClient } from 'mongodb';
import { createClient } from '@redis/client';

import { parseArgs, type OpsContext } from './ops/command';
import { commands } from './ops/commands';
import { setOpsConfig, type OpsConfig } from './ops_config';

const DEFAULT_CONFIG_REL = '../zonesvr/worker_thread_config.json';

async function main(): Promise<number> {
    // Separate the leading command name from the rest, so `parseArgs` sees a
    // clean flag list. First positional = command name.
    const raw = process.argv.slice(2);
    if (raw.length === 0) {
        console.error('usage: npm run ops -- <command> [options]');
        console.error('try: npm run ops -- help');
        return 2;
    }
    const commandName = raw[0];
    const argv = raw.slice(1);
    const args = parseArgs(argv);

    // `--config` is plumbed here (not in individual commands) because it
    // affects connection setup, not command logic.
    const configFlag = args.flags['config'];
    const configPath =
        typeof configFlag === 'string'
            ? path.resolve(process.cwd(), configFlag)
            : path.resolve(__dirname, DEFAULT_CONFIG_REL);
    const config = loadConfig(configPath);
    setOpsConfig(config);

    const cmd = commands.find((c) => c.name === commandName);
    if (!cmd) {
        console.error(`unknown command: "${commandName}"`);
        console.error('try: npm run ops -- help');
        return 2;
    }

    // Help is pure — don't open connections for it. Everything else needs both.
    if (cmd.name === 'help') {
        const ctx: OpsContext = {
            mongo: null as unknown as MongoClient, // unused
            redis: null, // unused
            log: console.log.bind(console),
        };
        await cmd.run(ctx, args);
        return 0;
    }

    const mongo = new MongoClient(config.mongoUri);
    const redis = createClient({ url: config.redisUri });
    // Suppress default @redis/client error spam during short-lived CLI runs;
    // unhandled rejections still surface via the main() catch.
    redis.on('error', (err: Error) => console.error('redis error:', err.message));
    await Promise.all([mongo.connect(), redis.connect()]);

    try {
        const ctx: OpsContext = {
            mongo,
            redis,
            log: console.log.bind(console),
        };
        await cmd.run(ctx, args);
        return 0;
    } finally {
        // quit() flushes; end() is harder stop. Either is fine for a CLI, but
        // quit gives a chance for inflight writes (e.g. rank:clear DELs) to
        // complete. Wrap in catch because Mongo close can throw after errors.
        await Promise.allSettled([mongo.close(), redis.quit()]);
    }
}

function loadConfig(p: string): OpsConfig {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OpsConfig>;
    if (typeof parsed.mongoUri !== 'string' || typeof parsed.redisUri !== 'string') {
        throw new Error(
            `config at ${p} is missing mongoUri or redisUri. ` +
                'The ops script expects the same shape as worker_thread_config.json.',
        );
    }
    return {
        mongoUri: parsed.mongoUri,
        redisUri: parsed.redisUri,
        cfgDbPath: parsed.cfgDbPath,
        tableKeysPath: parsed.tableKeysPath,
        _configDir: path.dirname(p),
    };
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err instanceof Error ? err.stack ?? err.message : err);
        process.exit(1);
    });
