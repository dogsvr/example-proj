# Error codes

Business error codes thrown by this project's handlers with `HandlerError(code, message)`. The client receives the code as `ret.err.code` (cl-tsrpc) or as the gRPC `Head.err_code` (server-to-server); the message only goes to the server log. Codes `1`–`1000` are reserved for dogsvr's framework codes, listed in [dogsvr's error code reference](https://github.com/dogsvr/dogsvr/blob/main/docs/reference/error_codes.md).

| Code | Server | Command | Meaning |
|---|---|---|---|
| 1001 | zonesvr | `ZONE_LOGIN` | Generating a gid for a new role failed |
| 1003 | zonesvr | `ZONE_QUERY_RANK_LIST` | Unknown `rankId` (no `TbRank` row) |
| 1004 | zonesvr | `ZONE_BATTLE_END_NTF`, `ZONE_QUERY_RANK_LIST` | Role not found for `openId` + `zoneId` |
| 1005 | zonesvr | `ZONE_LOGIN` | Empty or non-string role name |
| 1006 | zonesvr | `ZONE_LOGIN`, `ZONE_BATTLE_END_NTF` | Role lock is held by another request; retry later |
| 2001 | battlesvr | `BATTLE_START_BATTLE` | Request head lacks `gid` / `openId` / `zoneId` |

`ZONE_START_BATTLE` calls battlesvr: a battlesvr business code (e.g. 2001) reaches the client unchanged, while a battlesvr framework failure or an unreachable battlesvr reaches it as `dogsvr.DEPENDENCY_FAILED` (7).
