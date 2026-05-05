/**
 * `npm run pack` — produce a release tar.gz of all three example-* projects.
 *
 * What and why:
 *   The three sibling repos (example-proj, example-proj-cfg, example-proj-client)
 *   are built and tar'd together with their runtime node_modules. On the target
 *   machine, `tar xzf <release>.tar.gz && cd example-proj && pm2 start` is all
 *   that's required — no npm registry access, no build tools.
 *
 * Structural invariants enforced by this script:
 *   1. The tar's top-level directory matches the tar's basename (common
 *      convention; keeps `tar xzf` from spraying files into $CWD).
 *   2. example-proj/, example-proj-cfg/, example-proj-client/ sit as siblings
 *      inside that top-level dir. The relative symlink
 *      `example-proj/node_modules/example-proj-cfg -> ../../example-proj-cfg`
 *      still resolves, AND the hard-coded runtime path
 *      `../../../example-proj-cfg/dist/db` in zonesvr_logic.ts still resolves.
 *   3. Symlinks are preserved (never dereferenced). Deref'ing would turn the
 *      cfg symlink into a duplicate copy (manageable, ~1 MB) but the @dogsvr
 *      symlinks in deep transitive deps would explode.
 *
 * Non-goals: minify, compress JS further, strip debug info, or generate
 * anything that isn't a literal copy of built output. Parcel already
 * minifies client JS; tsc+tsc's dist output is already what pm2 runs in prod.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import { parseArgs, hasFlag, optStr } from './ops/command';
import { PROJECTS, type ProjectSpec } from './pack/projects';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** __dirname is `dist/scripts/` after tsc compile; two up gets back to example-proj/. */
const EXAMPLE_PROJ_DIR = path.resolve(__dirname, '..', '..');
/** Polyrepo parent (`/data/dogsvr-org/` on the reference machine). */
const POLYREPO_ROOT = path.resolve(EXAMPLE_PROJ_DIR, '..');

interface PackOptions {
    skipBuild: boolean;
    outDir: string;
    keepStage: boolean;
    skipped: Set<string>; // project.dir values to skip entirely
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const args = parseArgs(argv);

    const opts: PackOptions = {
        skipBuild: hasFlag(args, 'skip-build'),
        outDir: optStr(args, 'out') ?? path.join(EXAMPLE_PROJ_DIR, 'dist-release'),
        keepStage: hasFlag(args, 'keep-stage'),
        skipped: new Set(
            PROJECTS
                .filter((p) => p.skipFlag && hasFlag(args, p.skipFlag))
                .map((p) => p.dir),
        ),
    };

    const plan = preflight(opts);
    if (!opts.skipBuild) build(plan);
    const stageDir = stage(plan);
    writeManifest(stageDir, plan);
    const tarPath = tarball(stageDir, opts);
    verify(tarPath);
    // stageDir lives under os.tmpdir() — remove its parent (the whole
    // mkdtemp) so we don't leave breadcrumbs behind.
    const stageRoot = path.dirname(stageDir);
    if (!opts.keepStage) {
        fs.rmSync(stageRoot, { recursive: true, force: true });
        log(`cleanup: removed stage root ${stageRoot}`);
    } else {
        log(`stage kept at ${stageDir}`);
    }
}

interface PackPlan {
    tarName: string;   // "example-release-20260505-143022-abc1234" (or "...-abc1234-dirty")
    sha: string;       // short sha of example-proj (the anchor repo); may end in "-dirty"
    datestamp: string; // "20260505-143022"
    opts: PackOptions;
    active: ProjectSpec[]; // projects NOT skipped
    shaByProject: Record<string, string | null>;
    dirtyByProject: Record<string, boolean>;
}

function preflight(opts: PackOptions): PackPlan {
    log('== preflight ==');
    // Verify we're actually in the polyrepo parent, i.e. the three sibling
    // directories really exist where we expect. If someone copies this repo
    // out of /data/dogsvr-org/ (or renames a sibling), fail loudly instead
    // of producing a broken tar.
    for (const p of PROJECTS) {
        const abs = path.join(POLYREPO_ROOT, p.dir);
        if (!fs.existsSync(abs)) {
            throw new Error(
                `missing sibling repo: ${abs}\n` +
                `pack.ts expects all three example-* projects under ${POLYREPO_ROOT}.`,
            );
        }
    }
    const active = PROJECTS.filter((p) => !opts.skipped.has(p.dir));
    const shaByProject: Record<string, string | null> = {};
    const dirtyByProject: Record<string, boolean> = {};
    for (const p of PROJECTS) {
        const repoDir = path.join(POLYREPO_ROOT, p.dir);
        shaByProject[p.dir] = gitSha(repoDir);
        dirtyByProject[p.dir] = gitDirty(repoDir);
    }
    // Anchor label: if example-proj has uncommitted changes OR any sibling
    // that's being packed is dirty, append "-dirty" to the anchor sha. Any
    // drift from committed HEAD in ANY of the active projects invalidates the
    // promise "this tar matches the HEAD sha", so we surface that in the
    // tarball name so ops can't miss it at a glance.
    const anyDirty = active.some((p) => dirtyByProject[p.dir]);
    const anchorShaRaw = shaByProject['example-proj'] ?? 'nogit';
    const anchorSha = anyDirty ? `${anchorShaRaw}-dirty` : anchorShaRaw;
    const datestamp = formatDate(new Date());
    const tarName = `example-release-${datestamp}-${anchorSha}`;
    log(`polyrepo:    ${POLYREPO_ROOT}`);
    log(`active:      ${active.map((p) => p.dir).join(', ')}`);
    log(`skipped:     ${[...opts.skipped].join(', ') || '(none)'}`);
    log(`tar name:    ${tarName}.tar.gz`);
    log(`out dir:     ${opts.outDir}`);
    for (const p of PROJECTS) {
        const sha = shaByProject[p.dir] ?? 'nogit';
        const dirtyMark = dirtyByProject[p.dir] ? ' (dirty)' : '';
        log(`  ${p.dir.padEnd(22)} sha=${sha}${dirtyMark}`);
    }
    return { tarName, sha: anchorSha, datestamp, opts, active, shaByProject, dirtyByProject };
}

function build(plan: PackPlan): void {
    log('== build ==');
    for (const p of plan.active) {
        if (!p.build) {
            log(`${p.dir}: (no build step)`);
            continue;
        }
        if (p.dir === 'example-proj-client') {
            // Rationale (pack-specific client build isolation):
            // If a developer has `parcel serve` running in another terminal,
            // it continuously regenerates `dist/` in response to file changes.
            // Running `parcel build` against the same dist/ races the dev
            // server: both sides write hashed chunks, the resulting tar picks
            // up a mixture of the two, and the deployer ends up with dead
            // stale bundles alongside the live ones.
            //
            // The client's build command is configured (in pack/projects.ts)
            // to emit into `pack-dist/` and use its own `.parcel-cache-pack/`
            // cache dir, so dev-server state is never touched. We wipe both
            // before build to guarantee a deterministic output. After stage
            // finishes the copy, we rename pack-dist/ -> dist/ inside the
            // staged copy so the release layout matches what the deploy
            // README expects. See renameStagedClientDist below.
            const rmOpts = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
            const projRoot = path.join(POLYREPO_ROOT, p.dir);
            fs.rmSync(path.join(projRoot, 'pack-dist'), rmOpts);
            fs.rmSync(path.join(projRoot, '.parcel-cache-pack'), rmOpts);
            log(`${p.dir}: pre-build wipe of pack-dist/ + .parcel-cache-pack/`);
        }
        log(`${p.dir}: ${p.build.cmd} ${p.build.args.join(' ')}`);
        const res = spawnSync(p.build.cmd, p.build.args, {
            cwd: path.join(POLYREPO_ROOT, p.dir),
            stdio: 'inherit',
            shell: false,
        });
        if (res.status !== 0) {
            throw new Error(`build failed for ${p.dir} (exit ${res.status})`);
        }
    }
}

function stage(plan: PackPlan): string {
    log('== stage ==');
    fs.mkdirSync(plan.opts.outDir, { recursive: true });
    // Stage OUTSIDE the final outDir — otherwise copying example-proj/ into
    // example-proj/dist-release/… triggers fs.cpSync's "copy to a subdirectory
    // of self" guard. We use a sibling temp directory under the OS tmpdir,
    // keyed by the tar name so parallel runs don't collide.
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'example-pack-'));
    const stageDir = path.join(stageRoot, plan.tarName);
    fs.mkdirSync(stageDir, { recursive: true });
    for (const p of plan.active) {
        const src = path.join(POLYREPO_ROOT, p.dir);
        const dst = path.join(stageDir, p.dir);
        log(`${p.dir}: copying`);
        const counter = { files: 0, skipped: 0 };
        fs.cpSync(src, dst, {
            recursive: true,
            dereference: false,         // keep symlinks as symlinks
            verbatimSymlinks: true,     // don't rewrite the target path
            preserveTimestamps: true,
            filter: (srcPath) => {
                const rel = path.relative(src, srcPath);
                if (shouldExclude(rel, p)) {
                    counter.skipped++;
                    return false;
                }
                counter.files++;
                return true;
            },
        });
        const du = spawnSync('du', ['-sh', dst], { encoding: 'utf8' });
        log(`  ${counter.files} files, ${counter.skipped} skipped, size ${du.stdout?.trim() ?? '?'}`);
        // Client uses pack-dist/ as its parcel output (to avoid racing the
        // dev-server's dist/). Rename it to dist/ inside the staged copy so
        // the release layout matches the deploy README's expectations.
        if (p.dir === 'example-proj-client') {
            const src = path.join(dst, 'pack-dist');
            const tgt = path.join(dst, 'dist');
            if (fs.existsSync(src)) {
                fs.renameSync(src, tgt);
                log(`${p.dir}: staged pack-dist -> dist`);
            }
        }
    }
    return stageDir;
}

function writeManifest(stageDir: string, plan: PackPlan): void {
    log('== manifest ==');
    const manifest = {
        tarName: plan.tarName,
        createdAt: new Date().toISOString(),
        builder: {
            node: process.version,
            platform: `${process.platform}-${process.arch}`,
            osRelease: os.release(),
        },
        projects: Object.fromEntries(
            plan.active.map((p) => [
                p.dir,
                {
                    sha: plan.shaByProject[p.dir] ?? null,
                    dirty: plan.dirtyByProject[p.dir] ?? false,
                },
            ]),
        ),
    };
    fs.writeFileSync(path.join(stageDir, 'RELEASE.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(stageDir, 'README.txt'), README);
    log('wrote RELEASE.json + README.txt');
}

function tarball(stageDir: string, opts: PackOptions): string {
    log('== tar ==');
    const parent = path.dirname(stageDir);
    const base = path.basename(stageDir);
    const tarPath = path.join(opts.outDir, `${base}.tar.gz`);
    // Using system tar preserves symlinks + file modes + suffixes faithfully
    // and avoids adding a runtime dependency (`tar` npm package). The `-C`
    // + base-name form makes the tar contents start at `base/`, which is
    // what lets `tar xzf` land neatly in a single directory.
    const res = spawnSync('tar', ['-czf', tarPath, '-C', parent, base], {
        stdio: 'inherit',
    });
    if (res.status !== 0) {
        throw new Error(`tar failed (exit ${res.status})`);
    }
    return tarPath;
}

function verify(tarPath: string): void {
    log('== verify ==');
    const stat = fs.statSync(tarPath);
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    log(`size:        ${mb} MB  (${stat.size} bytes)`);
    const sha = sha256(tarPath);
    log(`sha256:      ${sha}`);
    log('path:        ' + tarPath);
    // Head + tail sample of the tar contents, so a human eyeballing the run
    // can sanity-check the top-level structure without having to untar.
    const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    log(`entries:     ${listing.length}`);
    log('--- first 10 entries ---');
    for (const line of listing.slice(0, 10)) log('  ' + line);
    log('--- last 5 entries ---');
    for (const line of listing.slice(-5)) log('  ' + line);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true iff the given path (relative to the project dir) matches any of
 * the project's exclude rules. Runs on every file fs.cpSync considers, so it
 * must be cheap — we do prefix / suffix checks, no regex.
 */
function shouldExclude(rel: string, p: ProjectSpec): boolean {
    if (rel === '') return false; // the root dir itself
    const norm = rel.split(path.sep).join('/');
    for (const dir of p.exclude.dirs ?? []) {
        if (norm === dir || norm.startsWith(dir + '/')) return true;
    }
    for (const suf of p.exclude.suffixes ?? []) {
        if (norm.endsWith(suf)) return true;
    }
    return false;
}

function gitSha(repoDir: string): string | null {
    try {
        const res = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
            cwd: repoDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return res.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Return true iff the working tree or index has any uncommitted changes.
 *
 * We run `git status --porcelain` and treat any non-empty output as dirty.
 * This catches:
 *   - modified but unstaged files
 *   - staged-but-not-committed files
 *   - untracked files (unless ignored by .gitignore)
 *
 * Rationale: the tar's payload is a literal copy of the working tree
 * (fs.cpSync in stage(), not `git archive`), so anything that makes the
 * working tree differ from HEAD also makes the tar differ from HEAD.
 * Surfacing that as "-dirty" in the tar name is the only safeguard against
 * ops confusing a dirty build with the committed sha.
 *
 * Returns false on missing git / non-repo / any error — same fall-through
 * semantics as gitSha(), so a non-git source directory just produces
 * "nogit" without dirty annotation.
 */
function gitDirty(repoDir: string): boolean {
    try {
        const res = execFileSync('git', ['status', '--porcelain'], {
            cwd: repoDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return res.trim().length > 0;
    } catch {
        return false;
    }
}

function formatDate(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    // Second precision (not minute) so multiple pack runs within the same
    // minute never collide on tar name. Local time, not UTC, because the
    // operator reading `ls dist-release/` expects their own wall-clock.
    return `${yyyy}${mm}${dd}-${HH}${MM}${SS}`;
}

function sha256(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function log(msg: string): void {
    console.log(msg);
}

// ---------------------------------------------------------------------------
// README shipped inside the tar
// ---------------------------------------------------------------------------

const README = `dogsvr example release bundle
=============================

Layout:
  example-proj/        dogsvr server (dir / zonesvr / battlesvr) + ops tool
  example-proj-cfg/    Luban/LMDB game config consumed by the server
  example-proj-client/ Phaser browser client (static assets)

Requirements on the target machine:
  - Linux x86-64 (mongodb has a native binding; glibc must match the builder)
  - Node.js >= 22 LTS
  - pm2 installed globally
  - Redis + MongoDB reachable at the URIs in
    example-proj/dist/zonesvr/worker_thread_config.json (and dir/, battlesvr/)

Deploy:
  cd example-proj
  pm2 start ecosystem.config.js

Publish client:
  cp -r ../example-proj-client/dist/* /var/www/html/   # or upload to CDN

Ops commands (same in dev and prod):
  cd example-proj
  npm run ops -- help
  npm run ops -- stats
  npm run ops -- zone:add --zone-id 100001 --name prod-1

See RELEASE.json for build metadata (git shas, node version, platform).
`;

main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
