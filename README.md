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
- **Web client** lives in [`example-proj-client`](https://github.com/dogsvr/example-proj-client) (Phaser 3)

## Topology

| Server | Ports (demo) | CL (inbound) | CLC (outbound) | Responsibility |
|---|---|---|---|---|
| **dir** | `10000` HTTP | tsrpc | — | Registration, zone list |
| **zonesvr** | `20000` WS, `20001` gRPC | tsrpc + grpc | → battlesvr (grpc) | Login, main game loop, leaderboards |
| **battlesvr** | `30001` gRPC, `30040` Colyseus | grpc | → zonesvr (grpc) | Real-time battle rooms (state-sync + lockstep) |

The port numbers above are just the values wired up in this demo's `main_thread_config.json` / `worker_thread_config.json`; in a real deployment plan your own port map and tweak those configs accordingly.

Each server lives under `src/<server>/` and follows the same shape: `<server>.ts` (main-thread entry) + `<server>_logic.ts` (`workerReady` init) + `cmd_handler.ts` (`regCmdHandler` calls) + `main_thread_config.json` + `worker_thread_config.json`. Common utilities (cmd ids, proto types, gid/redis/mongo/time helpers) live in `src/shared/`. See [Diagrams](#diagrams) below for request flow and a production deployment.

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

```sh
git clone https://github.com/dogsvr/example-proj.git
cd example-proj
npm install
npm run build        # tsc + copy *.json configs into dist/
npm run start        # pm2 start dir + zonesvr + battlesvr
pm2 ls               # should show 3 processes running
pm2 logs             # follow logs if anything is off
```

### Hot-updating worker logic

```sh
pm2 trigger dir       hotUpdate
pm2 trigger zonesvr   hotUpdate
pm2 trigger battlesvr hotUpdate
```

The main thread drains in-flight txns, replaces workers, and new requests start hitting the new code — no dropped connections.

### Local dev against polyrepo siblings

If you're hacking on `@dogsvr/dogsvr` / `cl-tsrpc` / `cl-grpc` / `cfg-luban` alongside this project, link them instead of reinstalling:

```sh
# In each sibling repo: npm link
# Then, from here:
npm run linkDog       # npm link @dogsvr/dogsvr @dogsvr/cl-tsrpc @dogsvr/cl-grpc @dogsvr/cfg-luban example-proj-cfg
```

## Running the client

```sh
git clone https://github.com/dogsvr/example-proj-client.git
cd example-proj-client
npm install
npm run start         # parcel serve, opens http://localhost:4567
```

Log in through the browser and the game connects to the three servers started above.

## Config data

Game tables (rewards, skills, items, …) live in [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg) as designer-authored Excel sheets. Building that repo produces an LMDB database plus TypeScript accessors that `worker_thread_config.json` points the server processes at. See its README for the pipeline — you don't need to rebuild it to run the demo, there's a prebuilt artifact checked in.

## Diagrams

Command flow:

![command flow](https://github.com/user-attachments/assets/531b3190-fc41-4dd1-823c-0287b3a45144)

One architecture for production environment:

![production architecture](https://github.com/user-attachments/assets/db55a062-f9af-4c24-b041-a16851142bd2)

## Next steps

- Framework internals (main/worker split, CL registration, hot update, LB strategies) → [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) README
- Writing your own connection layer, or what tsrpc/grpc CLs do → [`cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) / [`cl-grpc`](https://github.com/dogsvr/cl-grpc)
- Game config pipeline and runtime lookup APIs → [`cfg-luban`](https://github.com/dogsvr/cfg-luban) / [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg)
