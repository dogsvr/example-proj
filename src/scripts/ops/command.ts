/**
 * Ops command framework.
 *
 * Each command is a small object implementing {@link OpsCommand}. The dispatcher
 * in `../ops.ts` looks up a command by `name`, then calls `run(ctx, args)`.
 * Commands share a single Mongo + Redis connection via {@link OpsContext}, so
 * adding a new command is purely "drop a file under commands/ + one line in
 * commands/index.ts" — no framework wiring to touch.
 *
 * No third-party CLI library is used. `parseArgs` below is a ~30-line parser
 * that covers the flags we actually need (long flags with optional values plus
 * positional args). If we ever need shorthand flags, env-file loading, or
 * interactive prompts, that's the time to evaluate commander/yargs — not now.
 */

import type { MongoClient } from 'mongodb';
import * as readline from 'node:readline';

/**
 * Opaque Redis client handle. We intentionally use `any` here rather than
 * `ReturnType<typeof createClient>` because @redis/client v5 parameterises the
 * return type on RESP version / module / function / script generics, and those
 * don't align between call sites (our createClient() call picks RESP2 defaults,
 * but `redis.on('error', ...)` callbacks re-widen back to RespVersions, and
 * TypeScript can't unify). The concrete shape is fine at runtime; typing every
 * command to `any` here is the pragmatic call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RedisClient = any;

export interface OpsContext {
    mongo: MongoClient;
    redis: RedisClient;
    log: (...a: unknown[]) => void;
}

export interface ParsedArgs {
    /** Long flags, keyed by the flag name without the leading `--`. */
    flags: Record<string, string | boolean>;
    /** Remaining bare arguments, in order. */
    positional: string[];
}

export interface OpsCommand {
    /** Canonical name, e.g. `"zone:add"`. Colon-separated namespaces by convention. */
    name: string;
    /** One-line description for `help`. */
    summary: string;
    /** Usage line shown by `help <cmd>`, e.g. `"--zone-id <n> [--name <s>]"`. */
    args?: string;
    /** Longer description (multi-line ok) for `help <cmd>`. */
    details?: string;
    run(ctx: OpsContext, args: ParsedArgs): Promise<void>;
}

/**
 * Parse `argv` of the form `[--flag value | --bool-flag | positional ...]`.
 *
 * Rules:
 *   - `--foo bar` → `flags.foo = "bar"` (string)
 *   - `--foo=bar` → `flags.foo = "bar"` (string)
 *   - `--foo` (last arg, or followed by another `--flag`) → `flags.foo = true`
 *   - anything else → pushed to `positional`
 *
 * We intentionally do NOT support short flags (`-f`) or flag grouping (`-abc`);
 * all ops commands use readable long names.
 */
export function parseArgs(argv: string[]): ParsedArgs {
    const flags: Record<string, string | boolean> = {};
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq >= 0) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[body] = next;
            i++;
        } else {
            flags[body] = true;
        }
    }
    return { flags, positional };
}

/** Helper: read a required string flag, throw if missing. */
export function requireStr(args: ParsedArgs, flag: string): string {
    const v = args.flags[flag];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`missing required flag --${flag}`);
    }
    return v;
}

/** Helper: read a required numeric flag, throw if missing or NaN. */
export function requireNum(args: ParsedArgs, flag: string): number {
    const s = requireStr(args, flag);
    const n = Number(s);
    if (!Number.isFinite(n)) {
        throw new Error(`flag --${flag} must be a number, got "${s}"`);
    }
    return n;
}

/** Helper: read an optional string flag. */
export function optStr(args: ParsedArgs, flag: string): string | undefined {
    const v = args.flags[flag];
    return typeof v === 'string' ? v : undefined;
}

/** Helper: read an optional numeric flag. */
export function optNum(args: ParsedArgs, flag: string): number | undefined {
    const s = optStr(args, flag);
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) {
        throw new Error(`flag --${flag} must be a number, got "${s}"`);
    }
    return n;
}

/** Helper: truthy presence check, e.g. `--yes`. */
export function hasFlag(args: ParsedArgs, flag: string): boolean {
    return args.flags[flag] !== undefined;
}

/**
 * Destructive-action gate. Returns `true` if the caller should proceed with the
 * real mutation, `false` if it should print a dry-run summary and bail.
 *
 * Usage:
 *   if (!confirmDestructive(args, ctx, `will delete ${n} keys`)) return;
 *   // ...actually delete...
 */
export function confirmDestructive(
    args: ParsedArgs,
    ctx: OpsContext,
    summary: string,
): boolean {
    if (hasFlag(args, 'yes')) return true;
    ctx.log(`[dry-run] ${summary}`);
    ctx.log('Pass --yes to execute.');
    return false;
}

/**
 * Interactive confirmation over stdin. Used by the most dangerous commands
 * (rank:clear-all) in addition to the `--yes` flag gate, as a belt-and-braces
 * defense against scripted mistakes.
 */
export async function promptYesNo(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) =>
            rl.question(`${question} [yes/NO] `, resolve),
        );
        return answer.trim().toLowerCase() === 'yes';
    } finally {
        rl.close();
    }
}
