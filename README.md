# example-proj

A runnable three-server reference built on [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr). This is the project to read first if you want to see how the pieces of the dogsvr polyrepo fit together in a real game backend.

## What this shows

- **Multi-server topology** with pluggable connection layers ([`cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) + [`cl-grpc`](https://github.com/dogsvr/cl-grpc)) co-existing in one process
- **Main thread + worker threads** per server, with hot-update of worker logic via pm2
- **Server-to-server** calls via gRPC (`callCmdByClc`) — zonesvr ↔ battlesvr
- **Client push** via tsrpc WebSocket (`pushMsgByCl`)
- **Persistence**: MongoDB for player profiles + Redis for sessions, distributed locks, and ranking
- **Real-time rooms** via Colyseus — both state-sync and lockstep variants
- **Game config** via [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) fed from the companion repo [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg)
- **Web client** lives in [`example-proj-client`](https://github.com/dogsvr/example-proj-client) (Phaser 4)

## Topology

| Server | Ports (demo) | CL (inbound) | CLC (outbound) | Responsibility |
|---|---|---|---|---|
| **dir** | `10000` HTTP | tsrpc | — | Registration, zone list |
| **zonesvr** | `20000` WS, `20001` gRPC | tsrpc + grpc | → battlesvr (grpc) | Login, main game loop, leaderboards |
| **battlesvr** | `30001` gRPC, `30040` Colyseus WS | grpc | → zonesvr (grpc) | Real-time battle rooms (state-sync + lockstep) |

The port numbers above are the values wired in `main_thread_config.json` / `worker_thread_config.json`; change them freely for your own deployment.

Each server under `src/<server>/` follows the same structure:

- `<server>.ts` — main-thread entry (`loadMainThreadConfig`, `setupLogger`, `startServer`)
- `<server>_logic.ts` — worker entry (`workerReady`, `setupLoggerInWorker`, DB init)
- `cmd_handler.ts` — handler registrations (`regCmdHandler`)
- `main_thread_config.json` + `worker_thread_config.json`

Shared protocols (command IDs + DTO schemas, used by both server and client) live in `src/protocols/`. Server-internal helpers (gid, redis, mongo, time) live in `src/shared/`. See [Diagrams](#diagrams) for request flow.

## Polyrepo layout

The three `example-*` repos are independent git repositories and are expected to be cloned into the **same parent directory**:

```
<parent>/
├── example-proj/          # this repo — three-server backend
├── example-proj-cfg/      # designer Excel sheets + Luban/LMDB pipeline
└── example-proj-client/   # Phaser 4 web client
```

Cross-repo wiring:

| Consumer | Dependency | Mechanism | What it uses |
|---|---|---|---|
| `example-proj` | `example-proj-cfg` | `"file:../example-proj-cfg"` | Runtime config tables (`TbRank`, `RankType`, …) |
| `example-proj-client` | `example-proj` | `"file:../example-proj"` | `example-proj/protocols/cmd_id` + `/cmd_proto` (command ids and DTO schemas) |
| `example-proj-client` | `@dogsvr/cl-tsrpc` | npm registry | `@dogsvr/cl-tsrpc/protocols/*` (TSRPC Head / MsgCommon / PtlCommon / serviceProto) |

`file:` resolves as a symlink under `node_modules/` (npm default `install-links=false`), so edits in a sibling repo are picked up immediately after rebuilding that sibling — no reinstall needed. The flip side: if you clone `example-proj-client` without `example-proj` next to it, `npm install` in the client fails with `ENOENT`. Clone every repo you intend to run **before** installing.

Build order follows the dependency arrows — each repo consumes its upstream's compiled `dist/`, not source:

1. **`example-proj-cfg`** first — `npm install && npm run build` produces `dist/lib/cfg.{js,d.ts}` (the package entry) and the LMDB tables. Its `dist/` is gitignored, so a fresh clone has nothing usable until you build.
2. **`example-proj`** next — consumes `example-proj-cfg/dist/lib/*`. `npm run build` produces `dist/protocols/cmd_{id,proto}.{js,d.ts}` that the client depends on.
3. **`example-proj-client`** last — consumes both `example-proj/dist/protocols/*` and `@dogsvr/cl-tsrpc/dist/shared/protocols/*`.

Both `example-proj` and `@dogsvr/cl-tsrpc` expose only their `./protocols/*` subpath to the client; server-only modules (redis/mongo helpers, the `TsrpcCL` class) are whitelisted out of the browser bundle by the `exports` field.

## Prerequisites

- **Node.js**: tested on **v24.13.0 on Linux (x86-64)**; other maintained LTS lines are expected to work but are not routinely exercised. File an issue if something breaks on your runtime.
- **TypeScript** + **pm2** (globally or via `npx`)
- **Redis** and **MongoDB** — reachable from the servers. Deployment form is your call (managed service, dedicated boxes, docker, whatever); the demo just assumes they're on `localhost`.

For a throwaway local setup, docker containers work fine:

```sh
docker run --name dog-mongodb --network host -d mongodb/mongodb-community-server --bind_ip localhost
docker run --name dog-redis   --network host -d redis redis-server --bind 127.0.0.1
```

## Run

Build `example-proj-cfg` first — this repo consumes its compiled `dist/lib/cfg.{js,d.ts}` via `file:../example-proj-cfg` (see [Polyrepo layout](#polyrepo-layout) for the full chain):

```sh
cd <parent>
git clone https://github.com/dogsvr/example-proj-cfg.git
git clone https://github.com/dogsvr/example-proj.git

cd example-proj-cfg
npm install
npm run build                                  # Luban → LMDB + tsc → dist/lib/cfg.{js,d.ts}

cd ../example-proj
npm install
npm run build                                  # tsc → dist/ (incl. dist/protocols/ for the client) + copy *.json configs
npm run start                                  # pm2 start dir + zonesvr + battlesvr
pm2 ls                                         # should show 3 processes running
npm run logs                                   # follow logs (NDJSON piped through pino-pretty)
```

Building `example-proj-cfg` requires the extra toolchain (dotnet + Luban + flatc + python3) described in its README — a fresh clone alone won't build it.

### Hot-updating worker logic

```sh
pm2 trigger exp-dir       hotUpdate
pm2 trigger exp-zonesvr   hotUpdate
pm2 trigger exp-battlesvr hotUpdate
```

Process names (`exp-dir`, `exp-zonesvr`, `exp-battlesvr`) are defined in `ecosystem.config.js`; adjust if you rename them.

The main thread drains in-flight txns, replaces workers, and new requests start hitting the new code — no dropped connections.

### Local dev against polyrepo siblings

If you're hacking on `@dogsvr/dogsvr` / `cl-tsrpc` / `cl-grpc` / `cfg-luban` alongside this project, link them instead of reinstalling:

```sh
# In each sibling repo: npm link
# Then, from here:
npm run linkDog       # npm link @dogsvr/dogsvr @dogsvr/cl-tsrpc @dogsvr/cl-grpc @dogsvr/cfg-luban @dogsvr/logger
```

`example-proj-cfg` is consumed via `file:../example-proj-cfg` and does not need `npm link` — the symlink is wired up by `npm install` directly.

## Running the client

The client consumes `example-proj`'s compiled `dist/protocols/` — make sure the steps under [Run](#run) have completed successfully (both `example-proj-cfg` and `example-proj` built) before installing the client.

```sh
cd <parent>                                        # same parent directory as example-proj/
git clone https://github.com/dogsvr/example-proj-client.git
cd example-proj-client
npm install
npm run start                                      # parcel dev server (default port in package.json)
```

Log in through the browser and the game connects to the three servers started above.

If you're also hacking on `@dogsvr/cl-tsrpc` locally, run `npm run linkDog` in the client after `npm install` — it links the client's own copy of `@dogsvr/cl-tsrpc` to the sibling repo. (This is separate from the server-side `linkDog` script above; each consuming repo has its own.)

## Diagrams

Command flow:

![command flow](https://github.com/user-attachments/assets/531b3190-fc41-4dd1-823c-0287b3a45144)

One architecture for production environment:

![production architecture](https://github.com/user-attachments/assets/db55a062-f9af-4c24-b041-a16851142bd2)

## Next steps

- Framework internals (main/worker split, CL registration, hot update, LB strategies) → [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) README
- Writing your own connection layer, or what tsrpc/grpc CLs do → [`cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) / [`cl-grpc`](https://github.com/dogsvr/cl-grpc)
- Game config pipeline and runtime lookup APIs → [`cfg-luban`](https://github.com/dogsvr/cfg-luban) / [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg)
