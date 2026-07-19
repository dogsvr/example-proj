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

1. Main thread stops routing new requests to the old worker(s)
2. In-flight transactions drain
3. Workers are replaced with the new compiled code
4. New requests hit the new code — no dropped connections, no client-visible restart

## When to use

- After `npm run build` finishes and you want to pick up the change without a full pm2 restart.
- **Only worker-thread code** is hot-swappable. Changes in the main-thread entry (`<server>.ts`) or in `main_thread_config.json` require `npm run restart`.

## See also

- `@dogsvr/dogsvr` README — main/worker split and the hot-update protocol
- `docs/reference/server_structure.md` — which files run where
