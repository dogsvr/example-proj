import { WsClient } from 'tsrpc';
import { serviceProto } from '@dogsvr/cl-tsrpc/shared/protocols/serviceProto';

const client = new WsClient(serviceProto, {
    server: 'ws://127.0.0.1:3000'
});

async function Connect() {
    let connRes = await client.connect();
    if (!connRes.isSucc) {
        console.log('connect failed', connRes.errMsg);
        return;
    }
}

async function Call() {
    const req = {req: "Who are you"};
    let ret = await client.callApi('Common', {
        cmdId: 10001,
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    console.log(JSON.parse(ret.res.innerRes as string));
}

Connect().then(() => {setInterval(Call, 1000 * 5)});
