/**
 * Release packaging — per-project spec.
 *
 * The pack script iterates this array. Adding a fourth example-* project is
 * therefore "push one entry, update exclude patterns, done". No other file
 * needs to change.
 *
 * Paths are relative to the `/data/dogsvr-org` parent (resolved at runtime by
 * the preflight step). Excludes are matched via {@link shouldExclude} in
 * `../pack.ts`, using substring + suffix rules rather than full glob — we keep
 * the rule set small so the filter function stays readable and auditable.
 */

export interface ProjectSpec {
    /** Repo directory name under the polyrepo parent, e.g. "example-proj". */
    dir: string;
    /**
     * Shell-ish build command run from `dir`. First element is the program
     * passed to `spawnSync`; the rest are argv. `undefined` → skip build
     * (e.g. if a project has nothing to compile). A typical entry is
     * `['npm', 'run', 'build']` — extra flags appended per project.
     */
    build?: { cmd: string; args: string[] };
    /**
     * Paths INSIDE `dir` that must not end up in the tar. Two-part format:
     *   - `dirs`: prefix-match against the entry's path relative to `dir`.
     *     Matching stops `fs.cpSync` from descending.
     *   - `suffixes`: exact suffix match against the full filename (not just
     *     the basename — so "dist/foo.map" catches anywhere under dist).
     *
     * We do not use glob because shelling out to a glob lib would add a
     * dependency, and the rules are simple enough that substring match wins
     * on readability.
     */
    exclude: {
        dirs?: string[];
        suffixes?: string[];
    };
    /**
     * Optional CLI flag that, if set on the pack invocation, skips this
     * project entirely (for emergency split-releases). Matches `--no-<key>`.
     */
    skipFlag?: string;
}

/**
 * Ordering matters: build runs top-to-bottom. example-proj-cfg must build
 * before example-proj because the server consumes cfg's `dist/lib/cfg.js` at
 * build time (`import { RankType } from 'example-proj-cfg'`), and Parcel
 * bundles example-proj's protocols into example-proj-client, so that has to
 * build last.
 */
export const PROJECTS: ProjectSpec[] = [
    {
        dir: 'example-proj-cfg',
        build: { cmd: 'npm', args: ['run', 'build'] },
        exclude: {
            // Luban intermediate outputs — only the final LMDB + compiled
            // TS are needed to query at runtime.
            dirs: [
                'dist/bin',
                'dist/fbs',
                'dist/json',
                'dist/ts',
                'designer_cfg',
                'tools',
                // Do NOT blanket-exclude node_modules here. example-proj-cfg
                // is installed into example-proj via a symlink (see
                // example-proj/node_modules/example-proj-cfg ->
                // ../../example-proj-cfg/). Node's module resolver calls
                // realpath on that symlink before walking up for
                // node_modules, so `require('flatbuffers')` / `require('lmdb')`
                // inside example-proj-cfg/dist/lib/cfg/*.js always looks up
                // from the cfg repo itself, never finding example-proj's
                // own node_modules. The cfg package therefore MUST ship its
                // own runtime deps (flatbuffers, lmdb, and their transitive
                // native bindings). Only devDeps are stripped below.
                'node_modules/typescript',
                'node_modules/@types',
                'node_modules/undici-types',
                'node_modules/@dogsvr/cfg-luban-cli',
                '.git',
            ],
            // .d.ts.map is IDE-only; ship nothing that points back at src/ts.
            // Also scrub third-party source maps (same rationale as
            // example-proj below).
            suffixes: ['.d.ts.map', '.js.map', '.cjs.map', '.mjs.map', '.min.map'],
        },
        skipFlag: 'no-cfg',
    },
    {
        dir: 'example-proj',
        build: { cmd: 'npm', args: ['run', 'build'] },
        exclude: {
            dirs: [
                'src',                          // ship compiled JS, not TS
                'node_modules/.cache',
                'node_modules/.package-lock.json',
                // devDeps — they are in package.json devDependencies, but
                // `npm install` (no --omit=dev on the build machine) drags
                // them into node_modules. Strip them from the tar so the
                // release isn't paying for 30+ MB of compile toolchain.
                // Keep this list in sync with package.json devDependencies —
                // if that list grows, this one must grow too. There is no
                // automatic way to derive the mapping (package name →
                // install dir) without resolving each package.
                'node_modules/tsx',
                'node_modules/typescript',
                'node_modules/copyfiles',
                'node_modules/@types',
                'dist-release',                 // the tar output dir itself
                '.git',
            ],
            // Source map suffixes: third-party packages ship these in many
            // flavours. Seen in the wild across runtime deps: .js.map,
            // .cjs.map, .mjs.map, .min.map (async's old-school uglify format).
            // .d.ts.map is our own tsc output; no runtime value.
            suffixes: ['.d.ts.map', '.js.map', '.cjs.map', '.mjs.map', '.min.map'],
        },
    },
    {
        dir: 'example-proj-client',
        // Parcel: disable source maps (67 MB of .js.map otherwise) via CLI
        // flag, not by editing package.json — we don't want to affect dev
        // builds. `--dist-dir` points parcel at a pack-specific output
        // directory so the shared `dist/` stays untouched; otherwise a
        // developer running `parcel serve` in another terminal would race
        // this build and pollute the release with stale hashed chunks.
        build: {
            cmd: 'npm',
            args: [
                'run', 'build', '--',
                '--no-source-maps',
                '--dist-dir', 'pack-dist',
                '--cache-dir', '.parcel-cache-pack',
            ],
        },
        exclude: {
            dirs: [
                'src',
                'node_modules',                 // pure static: no runtime deps
                'dist',                         // dev-server output, not release
                '.parcel-cache',                // dev-server cache
                '.parcel-cache-pack',           // pack's own cache — keep out of tar
                '.git',
            ],
            // Belt-and-braces: even with --no-source-maps, scrub any lingering.
            suffixes: ['.js.map'],
        },
        skipFlag: 'no-client',
    },
];
