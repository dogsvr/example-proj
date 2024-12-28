import { createClient } from '@redis/client';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import * as crypto from "node:crypto";

const client = createClient({ url: 'redis://127.0.0.1:6379' });
client.on('error', err => console.log('Redis Client Error', err));

export async function initRedis() {
    await client.connect();
    dogsvr.infoLog('redis connected');
}

export function getRedisClient() {
    return client;
}

export class DistributedLock {
    private lockKey: string;
    private lockValue: string;
    private tryNum: number;
    private tryTimeout: number; // milliseconds
    private lockTTL: number; // seconds

    constructor(key: string, tryNum: number = 5, tryTimeout: number = 500, lockTTL: number = 5) {
        this.lockKey = key;
        this.lockValue = this.randomStr();
        this.tryNum = tryNum;
        this.tryTimeout = tryTimeout;
        this.lockTTL = lockTTL;
    }

    async lock() {
        let lock = false;
        for (let i = 0; i < this.tryNum; i++) {
            lock = await this.tryLock();
            if (lock)
                break;
            else if (i + 1 < this.tryNum)
                await new Promise(resolve => setTimeout(resolve, this.tryTimeout));
        }
        return lock;
    }

    async tryLock() {
        let lock = false;
        let res = await client.set(this.lockKey, this.lockValue, { NX: true, EX: this.lockTTL });
        if (res === 'OK') lock = true;
        return lock;
    }

    async unlock() {
        const lua_str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
        let res = await client.eval(lua_str, { keys: [this.lockKey], arguments: [this.lockValue] });
        if (res === 1) return true;
        return false;
    }

    private randomStr() {
        return crypto.randomBytes(64).toString('hex');
    }
}
