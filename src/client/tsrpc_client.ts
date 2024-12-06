import { WsClient } from 'tsrpc';
import { serviceProto } from '@dogsvr/cl-tsrpc/shared/protocols/serviceProto';
import * as cmdId from '../shared/cmd_id';

const client = new WsClient(serviceProto, {
    server: 'ws://127.0.0.1:2000'
});

async function connect() {
    let connRes = await client.connect();
    if (!connRes.isSucc) {
        console.log('connect failed', connRes.errMsg);
        return;
    }
}

async function getZoneList() {
    const req = {req: "getZoneList"};
    let ret = await client.callApi('Common', {
        cmdId: cmdId.DIR_QUERY_ZONE_LIST,
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    console.log(res);
    return res;
}

async function zoneLogin(openid:string, zoneid:number, name : string) {
    const req = { req: "zoneLogin", openid: openid, zoneid: zoneid, name: name };
    let ret = await client.callApi('Common', {
        cmdId: cmdId.ZONE_LOGIN,
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    console.log(res);
    return res;
}

async function startBattle() {
    const req = {req: "startBattle"};
    let ret = await client.callApi('Common', {
        cmdId: cmdId.ZONE_START_BATTLE,
        innerReq: JSON.stringify(req)
    });

    if (!ret.isSucc) {
        console.log('call failed', ret.err.message);
        return;
    }

    let res = JSON.parse(ret.res.innerRes as string);
    console.log(res);
    return res;
}

// Connect().then(() => {setInterval(Call, 1000 * 5)});

async function main()
{
    await connect();
    let res = await getZoneList();
    await zoneLogin("openid_should_be_uniq1", res.zonelist[0].zone_id, "dogtest");
    await startBattle();
}
main();
