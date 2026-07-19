import { MongoClient, Db, Collection, Document } from 'mongodb'
import { log as rootLog } from '@dogsvr/dogsvr/worker_thread';
import { RoleBriefInfo } from '../protocols/cmd_proto';
import { timeMongoOp } from '../otel/metrics_worker';

const log = rootLog.child({ module: 'mongo_proxy' });

const DB_NAME = "dogsvr-example-proj";
let client: MongoClient;
let cachedDb: Db | undefined;
const wrappedCollCache = new Map<string, Collection<Document>>();

export async function initMongo(uri: string) {
    client = new MongoClient(uri);
    await client.connect();
    cachedDb = client.db(DB_NAME);
    log.info('mongo connected');
}

export async function ensureRoleCollIndexes() {
    const collection = cachedDb!.collection('role_coll');
    await collection.createIndex({ openId: 1, zoneId: 1 });
    await collection.createIndex({ gid: 1 });
}

export function getMongoClient() {
    return client;
}

/**
 * Return a Collection where every async method is timed via mongo_op_duration_ms.
 * Synchronous methods (e.g. find returning a cursor) pass through; cursor terminal
 * methods (toArray, next) are wrapped recursively.
 *
 * Db and wrapped Collection are cached — both are stateless views over the shared
 * MongoClient pool, and re-allocating them per call is not free at high QPS.
 */
export function timedColl<T extends Document = Document>(coll: string): Collection<T> {
    let wrapped = wrappedCollCache.get(coll);
    if (!wrapped) {
        const raw = cachedDb!.collection<Document>(coll);
        wrapped = wrapAsyncMethods(raw, coll, '') as Collection<Document>;
        wrappedCollCache.set(coll, wrapped);
    }
    return wrapped as unknown as Collection<T>;
}

function wrapAsyncMethods<O extends object>(target: O, coll: string, prefix: string): O {
    return new Proxy(target, {
        get(t, prop, recv) {
            const orig = Reflect.get(t, prop, recv);
            if (typeof orig !== 'function' || typeof prop !== 'string') return orig;
            return (...args: unknown[]) => {
                const ret = (orig as (...a: unknown[]) => unknown).apply(t, args);
                const opLabel = prefix ? `${prefix}.${prop}` : prop;
                if (ret instanceof Promise) {
                    return timeMongoOp(coll, opLabel, () => ret as Promise<unknown>);
                }
                // Cursor-like: wrap recursively so .toArray() etc. are timed.
                if (ret && typeof ret === 'object' && hasAsyncMethods(ret)) {
                    return wrapAsyncMethods(ret as object, coll, opLabel);
                }
                return ret;
            };
        },
    }) as O;
}

function hasAsyncMethods(o: object): boolean {
    return typeof (o as { toArray?: unknown }).toArray === 'function'
        || typeof (o as { next?: unknown }).next === 'function';
}

const roleBriefInfoProjection: Record<keyof RoleBriefInfo, 1> & { _id: 0 } = {
    _id: 0, openId: 1, zoneId: 1, gid: 1, name: 1
};

export async function batchQueryRoleBriefInfo(gids: number[]): Promise<Map<number, RoleBriefInfo>> {
    const map = new Map<number, RoleBriefInfo>();
    if (gids.length === 0) return map;
    const docs = await timedColl('role_coll')
        .find({ gid: { $in: gids } }, { projection: roleBriefInfoProjection })
        .toArray();
    for (const doc of docs) {
        map.set(doc.gid as number, doc as unknown as RoleBriefInfo);
    }
    return map;
}
