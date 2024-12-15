export type ZoneInfo = {
    zoneId: number;
    name: string;
    address: string;
    mergeTo: number;
};
export type RoleInfo = {
    openId: string;
    zoneId: number;
    name: string;
    score: number;
};

export type DirQueryZoneListReq = {
};
export type DirQueryZoneListRes = {
    zoneList: ZoneInfo[];
};

export type ZoneLoginReq = {
    openId: string;
    zoneId: number;
};
export type ZoneLoginRes = {
    role: RoleInfo;
};

export type ZoneStartBattleReq = {
};
export type ZoneStartBattleRes = {
    roomType: string;
    battleSvrAddr: string;
};

export type ZoneBattleEndNtf = {
    scoreChange: number;
    role: RoleInfo;
};

export type BattleStartBattleReq = {
};
export type BattleStartBattleRes = {
    roomType: string;
    battleSvrAddr: string;
};
