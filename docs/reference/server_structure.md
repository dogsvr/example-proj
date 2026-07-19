# Server internal structure

Every server (`dir`, `zonesvr`, `battlesvr`) under `src/servers/<server>/` follows the same skeleton.

## File map

| File | Runs on | Purpose |
|---|---|---|
| `<server>.ts` | Main thread | Entry point — calls `loadMainThreadConfig`, `setupLogger`, `startServer` |
| `<server>_logic.ts` | Worker thread | Entry point — calls `workerReady`, `setupLoggerInWorker`, initializes DB clients |
| `cmd_handler.ts` | Worker thread | Registers request handlers via `regCmdHandler` |
| `main_thread_config.json` | Config | Main-thread bootstrap config (CL bindings, ports, worker count) |
| `worker_thread_config.json` | Config | Worker-thread runtime config (Mongo/Redis URIs, log level, service-specific settings) |

The main-thread half is tiny — it just wires connection layers (CL/CLC), spawns workers, and forwards traffic. Business logic lives entirely in the worker half.

`battlesvr/` additionally has:

- `rooms/` — Colyseus room implementations (`state_sync_battle_room.ts` + `lockstep_sync_battle_room.ts`)
- `session_ticket.ts` — one-shot login ticket verified when a client joins a room

## Config file shape (abridged)

Common keys in `main_thread_config.json`:

```jsonc
{
  "workerCount": 1,
  "cls": [
    { "name": "tsrpc", "type": "tsrpc-http", "port": 10000 }
  ]
}
```

Common keys in `worker_thread_config.json`:

```jsonc
{
  "mongoUri": "mongodb://localhost:27017",
  "redisUri": "redis://localhost:6379",
  "log": { "enabled": true, "level": "info" },
  "otel": { ... }
}
```

For the authoritative schema see the type definitions in the `@dogsvr/dogsvr` package and each server's `<server>_logic.ts` (which parses its own extended config).

## Related packages

Server-internal helpers (gid / redis / mongo / time) live in `src/lib/`.

Shared protocols (command IDs + DTO schemas used by both server and client) live in `src/protocols/` and are re-exported to the client via `package.json` `exports."./protocols/*"`.

## See also

- `docs/explanation/polyrepo_layout.md` — how `example-proj` fits into the polyrepo
- `docs/how-to/hot_update.md` — replacing worker code without a full restart
- `@dogsvr/dogsvr` README — main/worker split, CL registration, hot-update protocol
