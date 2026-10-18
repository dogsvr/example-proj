// pm2 ecosystem file for example-proj.
const path = require('node:path');

const cwd = __dirname;
const base = {
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // Only main-thread fatal errors exit now (workers recover in-process); back off: 100ms ×1.5, pm2 caps at 15s.
    exp_backoff_restart_delay: 100,
    kill_timeout: 5000,
    time: false,
    cwd,
    // Disable @pm2/io agent: its http.emit monkey-patch adds CPU overhead on
    // WebSocket-heavy paths. `pm2 trigger` still works via dogsvr's native IPC.
    env: {
        PM2_IO: 'false',
    },
};

module.exports = {
    apps: [
        {
            ...base,
            name: 'exp-dir',
            script: path.join('dist', 'servers', 'dir', 'dir.js'),
        },
        {
            ...base,
            name: 'exp-zonesvr',
            script: path.join('dist', 'servers', 'zonesvr', 'zonesvr.js'),
        },
        {
            ...base,
            name: 'exp-battlesvr',
            script: path.join('dist', 'servers', 'battlesvr', 'battlesvr.js'),
        },
    ],
};
