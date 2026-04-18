import { MongoClient } from 'mongodb'
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { RoleBriefInfo } from './cmd_proto';

let client: MongoClient;

export async function initMongo(uri: string) {
    client = new MongoClient(uri);
    await client.connect();
    dogsvr.infoLog('mongo connected');
}

export async function ensureRoleCollIndexes() {
    const db = client.db("dogsvr-example-proj");
    const collection = db.collection('role_coll');
    await collection.createIndex({ openId: 1, zoneId: 1 });
    await collection.createIndex({ gid: 1 });
}

export function getMongoClient() {
    return client;
}

const roleBriefInfoProjection: Record<keyof RoleBriefInfo, 1> & { _id: 0 } = {
    _id: 0, openId: 1, zoneId: 1, gid: 1, name: 1
};

export async function batchQueryRoleBriefInfo(gids: number[]): Promise<Map<number, RoleBriefInfo>> {
    const map = new Map<number, RoleBriefInfo>();
    if (gids.length === 0) return map;
    const db = getMongoClient().db("dogsvr-example-proj");
    const docs = await db.collection('role_coll')
        .find({ gid: { $in: gids } }, { projection: roleBriefInfoProjection })
        .toArray();
    for (const doc of docs) {
        map.set(doc.gid as number, doc as unknown as RoleBriefInfo);
    }
    return map;
}
