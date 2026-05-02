// pm2 ecosystem file for example-proj.
//
// Design notes:
// - exec_mode stays the implicit "fork" default. dogsvr spawns its own
//   worker_threads inside each process, so letting pm2 run a cluster of
//   duplicate node processes would double-schedule workers.
// - No wait_ready / listen_timeout: the three servers have NO startup ordering
//   dependency (gRPC clients only resolve addresses when the first RPC fires).
// - Process names prefixed `exp-` so they don't collide with other projects
//   sharing the same pm2 daemon.
// - cwd is pinned so `pm2 start ecosystem.config.js` works regardless of the
//   directory the command is invoked from.
const path = require('node:path');

const cwd = __dirname;
const base = {
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 5000,
    cwd,
};

module.exports = {
    apps: [
        {
            ...base,
            name: 'exp-dir',
            script: path.join('dist', 'dir', 'dir.js'),
        },
        {
            ...base,
            name: 'exp-zonesvr',
            script: path.join('dist', 'zonesvr', 'zonesvr.js'),
        },
        {
            ...base,
            name: 'exp-battlesvr',
            script: path.join('dist', 'battlesvr', 'battlesvr.js'),
        },
    ],
};
