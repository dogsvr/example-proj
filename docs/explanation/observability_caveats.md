# Observability caveats

## ELU metric reads high under continuous profiling

With CPU profiling enabled (continuous or on-demand via the profiling endpoint), the `dogsvr_worker_elu_utilization` gauge reads high (typically 30–50%) even when the worker is idle.

### Cause

CPU profiling in Node.js uses `SIGPROF`-based sampling at ~1 kHz. libuv's idle accounting is perturbed by the signal delivery — the worker is not actually busy, but the ELU counter sees the sampler run as work.

### Impact

- **ELU under profiling is not meaningful for capacity alerting.** Do not page on it while profiling is on.
- The metric is fine when profiling is off; only the "profiling ON" reading is skewed.

### Workaround

For capacity alerting during profiling, use:

- `dogsvr_worker_eventloop_lag_seconds` — event-loop lag, unaffected by SIGPROF sampling
- `%CPU` from `top` / `htop` / OS-level metrics — reflects real CPU

### Full write-up

See [`example-proj-stress/profiling/PROFILING_MANUAL.md`](../../../example-proj-stress/profiling/PROFILING_MANUAL.md#10-已知观测偏差) §10 for the measurement details and the internal libuv mechanism.
