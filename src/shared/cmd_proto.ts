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
export type RoleId = {
    openId?: string;
    zoneId?: number;
    gid?: number; // TODO
};
export type RoleBriefInfo = {
    roleId: RoleId;
    name: string;
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
    syncType: string;
};
export type ZoneStartBattleRes = {
    roomType: string;
    battleSvrAddr: string;
};

export type ZoneBattleEndNtf = {
    scoreChange: number;
    role: RoleInfo;
};

export type RankMember = {
    roleBriefInfo?: RoleBriefInfo;
    score: number;
    updateTs: number;
    rank: number; // [1, n], 0 means not in rank
};
export type ZoneQueryRankListReq = {
    rankType: string; // TODO
    offset: number; // [0, n]
    count: number;
};
export type ZoneQueryRankListRes = {
    rankList: RankMember[];
    selfRank: RankMember;
};

export type BattleStartBattleReq = {
    syncType: string;
};
export type BattleStartBattleRes = {
    roomType: string;
    battleSvrAddr: string;
};
