// pm2 ecosystem file for example-proj.
const path = require('node:path');

const cwd = __dirname;
const base = {
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
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
