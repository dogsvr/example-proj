# example-proj

A runnable three-server reference built on [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr). Start here if you want to see how the pieces of the dogsvr polyrepo fit together in a real game backend.

## What this shows

- **Multi-server topology** with pluggable connection layers ([`cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) + [`cl-grpc`](https://github.com/dogsvr/cl-grpc)) co-existing in one process
- **Main thread + worker threads** per server, with hot-update of worker logic via pm2
- **Server-to-server calls** via gRPC (`callCmdByClc`) — zonesvr ↔ battlesvr
- **Client push** via tsrpc WebSocket (`pushMsgByCl`)
- **Persistence**: MongoDB for player profiles + Redis for sessions, distributed locks, and ranking
- **Real-time rooms** via Colyseus — both state-sync and lockstep variants
- **Game config** via [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) fed from the companion repo [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg)
- **Web client** in [`example-proj-client`](https://github.com/dogsvr/example-proj-client) (Phaser 4)

## Topology

| Server | Ports (demo) | CL (inbound) | CLC (outbound) | Responsibility |
|---|---|---|---|---|
| **dir** | `10000` HTTP | tsrpc | — | Registration, zone list |
| **zonesvr** | `20000` WS, `20001` gRPC | tsrpc + grpc | → battlesvr (grpc) | Login, main game loop, leaderboards |
| **battlesvr** | `30001` gRPC, `30040` Colyseus WS | grpc | → zonesvr (grpc) | Real-time battle rooms (state-sync + lockstep) |

Ports come from `main_thread_config.json` / `worker_thread_config.json`; change them freely for your own deployment. For the file layout inside each server, see [`docs/reference/server_structure.md`](docs/reference/server_structure.md).

## Prerequisites

- **Node.js**: tested on **v24.13.0 on Linux (x86-64)**; other maintained LTS lines are expected to work but are not routinely exercised.
- **TypeScript** + **pm2** (globally or via `npx`).
- **Redis** and **MongoDB** — reachable from the servers. For a throwaway local setup, docker containers on `localhost` work fine.

## Run

`example-proj` depends on `example-proj-cfg`'s compiled `dist/lib/*` via `file:../example-proj-cfg`, so both repos must be cloned side-by-side and cfg must build first. See [`docs/explanation/polyrepo_layout.md`](docs/explanation/polyrepo_layout.md) for the full dependency chain and rationale.

```sh
cd <parent>
git clone https://github.com/dogsvr/example-proj-cfg.git
git clone https://github.com/dogsvr/example-proj.git

cd example-proj-cfg
npm install
npm run build                                  # Luban → LMDB + tsc → dist/lib/cfg.{js,d.ts}

cd ../example-proj
npm install
npm run build                                  # tsc → dist/ (incl. dist/protocols/) + copy *.json configs
npm run start                                  # pm2 start dir + zonesvr + battlesvr
pm2 ls                                         # should show 3 processes running
npm run logs                                   # follow logs (NDJSON piped through pino-pretty)
```

Building `example-proj-cfg` requires an extra toolchain (dotnet + Luban + flatc + python3); see its README.

## Running the client

Once `example-proj-cfg` and `example-proj` have built successfully:

```sh
cd <parent>
git clone https://github.com/dogsvr/example-proj-client.git
cd example-proj-client
npm install
npm run start                                      # parcel dev server
```

Log in through the browser and the game connects to the three servers started above.

## Diagrams

Command flow:

![command flow](https://github.com/user-attachments/assets/531b3190-fc41-4dd1-823c-0287b3a45144)

One architecture for production environment:

![production architecture](https://github.com/user-attachments/assets/db55a062-f9af-4c24-b041-a16851142bd2)

## More

- [`docs/how-to/`](docs/how-to/) — task-oriented recipes ([hot-update workers](docs/how-to/hot_update.md), [local dev with `npm link`](docs/how-to/local_dev_with_linkdog.md))
- [`docs/reference/`](docs/reference/) — internal structure and config schema ([server structure](docs/reference/server_structure.md))
- [`docs/explanation/`](docs/explanation/) — design rationale and domain knowledge ([polyrepo layout](docs/explanation/polyrepo_layout.md), [multiplayer netcode](docs/explanation/multiplayer_netcode.md), [logger `Level` placement ADR](docs/explanation/logger_level_type_design.md), [observability caveats](docs/explanation/observability_caveats.md))

Related repos in the dogsvr ecosystem:

- Framework: [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) · [`@dogsvr/logger`](https://github.com/dogsvr/logger)
- Connection layers: [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) · [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc)
- Config pipeline: [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) · [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg)
- Client: [`example-proj-client`](https://github.com/dogsvr/example-proj-client)
- Load testing: [`example-proj-stress`](https://github.com/dogsvr/example-proj-stress)
