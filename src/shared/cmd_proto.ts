export type ZoneInfo = {
    zoneId: number;
    name: string;
    address: string;
    mergeTo: number;
};
export type RoleInfo = {
    openId: string;
    zoneId: number;
    gid: number;
    name: string;
    score: number;
    cityId?: number;
    provinceId?: number;
};
export type RoleBriefInfo = {
    openId?: string;
    zoneId?: number;
    gid?: number;
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
    // one-time session ticket issued by battlesvr; client forwards it to Colyseus onAuth
    ticket: string;
    // ticket TTL in ms, informational only (for client-side diagnostics / logs)
    ticketTtlMs: number;
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
    rankId: number; // TbRank primary key, corresponds to the `id` column in example-proj-cfg/designer_cfg/Datas/rank.xlsx
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
    // one-time session ticket; consumed in Colyseus onAuth to recover {gid, openId, zoneId}
    ticket: string;
    // ticket TTL in ms, informational only
    ticketTtlMs: number;
};
