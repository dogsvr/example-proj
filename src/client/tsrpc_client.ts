import { WsClient } from 'tsrpc';
import { serviceProto } from '@dogsvr/cl-tsrpc/shared/protocols/serviceProto';
import { MsgCommon } from '@dogsvr/cl-tsrpc/shared/protocols/MsgCommon';
import * as cmdId from '../shared/cmd_id';

const client = new WsClient(serviceProto, {
    server: 'ws://127.0.0.1:2000'
});

client.listenMsg("Common", (msg: MsgCommon) => {
    console.log("recv server push:", msg);
});

async function connect() {
    let connRes = await client.connect();
    if (!connRes.isSucc) {
        console.log('connect failed', connRes.errMsg);
        return;
    }
}

let openId = "";
let zoneId = 0;
let name = "";

async function getZoneList() {
    const req = { req: "getZoneList" };
    let ret = await client.callApi('Common', {
        head: {
            cmdId: cmdId.DIR_QUERY_ZONE_LIST,
            openId: "",
            zoneId: 0
        },
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

async function zoneLogin() {
    const req = { req: "zoneLogin", openid: openId, zoneid: zoneId, name: name };
    let ret = await client.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_LOGIN,
            openId: openId,
            zoneId: zoneId
        },
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
    const req = { req: "startBattle" };
    let ret = await client.callApi('Common', {
        head: {
            cmdId: cmdId.ZONE_START_BATTLE,
            openId: openId,
            zoneId: zoneId
        },
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

async function main() {
    await connect();
    
    let res = await getZoneList();
    openId = "openid_should_be_uniq1";
    zoneId = res.zonelist[0].zone_id;
    name = "dogtest";
    
    await zoneLogin();
    
    await startBattle();
}
main();
