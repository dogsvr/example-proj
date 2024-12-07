import { MongoClient } from 'mongodb'
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

const client = new MongoClient('mongodb://127.0.0.1:27017');

export async function initMongo() {
    await client.connect();
    dogsvr.infoLog('mongo connected');
}

export function getMongoClient() {
    return client;
}
