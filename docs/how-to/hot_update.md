# Hot-update worker logic

The main thread stays up. Only the workers (business logic) get replaced.

## Command

```sh
pm2 trigger exp-dir       hotUpdate
pm2 trigger exp-zonesvr   hotUpdate
pm2 trigger exp-battlesvr hotUpdate
```

Process names (`exp-dir`, `exp-zonesvr`, `exp-battlesvr`) are defined in `ecosystem.config.js`; adjust if you renamed them.

## What happens

1. A new worker loads the freshly built code and runs its init; the old worker keeps serving meanwhile.
2. Once the new worker is ready it takes over the slot, and new requests hit the new code. The old worker finishes its in-flight transactions and stops. Client connections live in the main thread and stay up — except battles on battlesvr (see below).
3. `rolling` (the default) does this one slot at a time; `allAtOnce` starts every new worker first and swaps only if all of them are ready.

## Reading the result

- The CLI prints `hotUpdate done` or `hotUpdate failed: <reason>` and **exits 0 either way** — check the text, not the exit code.
- A `rolling` abort such as `hot update aborted at slot 1: init failed: Error: …; slots 0 already on the new code` means slot 0 now runs the new code and slot 1 still runs the old code, until the next hot update or restart. A slot that crashes later respawns from the files on disk, i.e. the new build.
- Triggering again while an update is running joins that update instead of starting another one. To pick up a build made after the first trigger, trigger again once it has finished.

## battlesvr caveat

Colyseus rooms live inside the battlesvr worker. When the old worker stops, every battle in progress on it is disconnected (clients see close code 1006). Hot-update battlesvr only when no battle is running, or restart it in a maintenance window.

## When to use

- After `npm run build` finishes and you want to pick up the change without a full pm2 restart.
- **Only worker-thread code** is hot-swappable. Changes in the main-thread entry (`<server>.ts`) or in `main_thread_config.json` require `npm run restart`.

## See also

- `@dogsvr/dogsvr` README — main/worker split and the hot-update protocol
- `docs/reference/server_structure.md` — which files run where
