# Polyrepo layout

`example-proj` is one of a small set of independent git repositories that together demonstrate a dogsvr-based backend. They are **not** a monorepo and **not** an npm workspace; each is a standalone package installed with its own `npm install`.

## Physical layout

The `example-*` repos must be cloned into the **same parent directory**:

```
<parent>/
├── example-proj/          # this repo — three-server backend
├── example-proj-cfg/      # designer Excel sheets + Luban/LMDB pipeline
└── example-proj-client/   # Phaser 4 web client
```

`example-proj-stress/` (load-testing bots + observability stack) is a fourth optional sibling.

## Cross-repo wiring

| Consumer | Dependency | Mechanism | What it uses |
|---|---|---|---|
| `example-proj` | `example-proj-cfg` | `"file:../example-proj-cfg"` | Runtime config tables (`TbRank`, `RankType`, …) |
| `example-proj-client` | `example-proj` | `"file:../example-proj"` | `example-proj/protocols/cmd_id` + `/cmd_proto` (command IDs and DTO schemas) |
| `example-proj-client` | `@dogsvr/cl-tsrpc` | npm registry | `@dogsvr/cl-tsrpc/protocols/*` (TSRPC `Head` / `MsgCommon` / `PtlCommon` / serviceProto) |

`file:` resolves as a symlink under `node_modules/` (npm default `install-links=false`), so edits in a sibling repo are picked up immediately after rebuilding that sibling — no reinstall needed.

The flip side: if you clone `example-proj-client` **without** `example-proj` next to it, `npm install` in the client fails with `ENOENT`. Clone every repo you intend to run **before** installing.

## Build order

Follows the dependency arrows — each repo consumes its upstream's compiled `dist/`, not source:

1. **`example-proj-cfg`** first — `npm install && npm run build` produces `dist/lib/cfg.{js,d.ts}` (the package entry) and the LMDB tables. Its `dist/` is gitignored, so a fresh clone has nothing usable until you build.
2. **`example-proj`** next — consumes `example-proj-cfg/dist/lib/*`. `npm run build` produces `dist/protocols/cmd_{id,proto}.{js,d.ts}` that the client depends on.
3. **`example-proj-client`** last — consumes both `example-proj/dist/protocols/*` and `@dogsvr/cl-tsrpc/dist/shared/protocols/*`.

Both `example-proj` and `@dogsvr/cl-tsrpc` expose only their `./protocols/*` subpath to the client via the `exports` field; server-only modules (redis/mongo helpers, the `TsrpcCL` class) are whitelisted out of the browser bundle by that same mechanism.

## Why not a monorepo?

- Each repo has its own release cycle. `example-proj-cfg` regenerates on designer Excel changes; `example-proj-client` on frontend work; `example-proj` on backend work. Coupling them into one repo would force cross-team retriggers.
- Building `example-proj-cfg` requires a toolchain (dotnet + Luban + flatc + python3) that server-side developers should not have to install.
- `example-proj-client` targets the browser; its build tools (parcel) and dependencies are completely different from the server-side.

Polyrepo is the honest expression of these decoupled release cycles. `file:` linking gives us the ergonomics of a monorepo (edit-in-place, no publish step) while preserving the boundary.

## See also

- `.claude/CLAUDE.md` §Polyrepo Layout — full inventory of the dogsvr polyrepo (framework + libs + example projects)
- `docs/how-to/local_dev_with_linkdog.md` — using `npm link` for the framework packages
