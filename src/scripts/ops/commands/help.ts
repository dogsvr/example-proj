/**
 * `help` introspects the command registry and formats it. Because it needs the
 * full list, we import from commands/index.ts — which must NOT re-import this
 * file to avoid a cycle. commands/index.ts therefore only imports leaves.
 */

import type { OpsCommand } from '../command';
import { commands } from './index';

export const help: OpsCommand = {
    name: 'help',
    summary: 'List all commands, or show full details for one.',
    args: '[<command>]',
    async run(ctx, args) {
        const which = args.positional[0];
        if (!which) {
            ctx.log('Usage: npm run ops -- <command> [options]');
            ctx.log('');
            ctx.log('Commands:');
            const maxName = Math.max(...commands.map((c) => c.name.length));
            for (const c of commands) {
                ctx.log(`  ${c.name.padEnd(maxName)}  ${c.summary}`);
            }
            ctx.log('');
            ctx.log('Run "npm run ops -- help <command>" for details and flags.');
            return;
        }
        const cmd = commands.find((c) => c.name === which);
        if (!cmd) {
            ctx.log(`no such command: "${which}"`);
            ctx.log('try "help" for the full list.');
            return;
        }
        printOne(cmd, ctx.log);
    },
};

function printOne(cmd: OpsCommand, log: (...a: unknown[]) => void): void {
    log(`${cmd.name}`);
    log(`  ${cmd.summary}`);
    if (cmd.args) log(`  usage: ${cmd.name} ${cmd.args}`);
    if (cmd.details) {
        log('');
        for (const line of cmd.details.split('\n')) log(`  ${line}`);
    }
}
