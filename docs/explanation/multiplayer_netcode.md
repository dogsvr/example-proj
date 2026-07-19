# Multiplayer Netcode — 方案选型与权衡

> 本文档梳理多人实时游戏中"客户端如何同步服务器世界状态"的常见方案、它们的成因/限制,以及不同游戏类型下的最佳组合。
> 内容源自本仓库 state-sync battle 实践 + 行业 FPS / 格斗类网络架构经验。

## 目录

1. [问题域:为什么需要 netcode](#1-问题域为什么需要-netcode)
2. [基础术语](#2-基础术语)
3. [核心方案分类](#3-核心方案分类)
4. [Snapshot Buffer(全员插值)详解](#4-snapshot-buffer全员插值详解)
5. [Self Prediction(客户端预测)详解](#5-self-prediction客户端预测详解)
6. [混合架构的核心痛点:时间差](#6-混合架构的核心痛点时间差)
7. [12 类时间差具体问题](#7-12-类时间差具体问题)
8. [9 种解决方案](#8-9-种解决方案)
9. [按游戏类型的方案组合](#9-按游戏类型的方案组合)
10. [拳皇类格斗游戏:工业现实](#10-拳皇类格斗游戏工业现实)
11. [本仓库当前选型与演进路径](#11-本仓库当前选型与演进路径)
12. [参考资料](#12-参考资料)

---

## 1. 问题域:为什么需要 netcode

实时多人游戏要解决一个看似简单但本质矛盾的问题:**N 个 client 如何对"现在世界长什么样"达成一致**。

物理现实:
- 光速 → 信号在地球两端往返至少 ~150ms
- 普通家用网络 RTT 30-150ms 是常态
- 服务器仿真节奏 ≠ 客户端渲染帧率 ≠ 网络 patch 频率
- 数据包可能丢失、乱序(WebSocket 提供有序保证但不防延迟)

不做处理,玩家会体验到:
- **位置抖动 / 卡顿**:server 推送间隔(20-30Hz)< 屏幕刷新率(60-120Hz)
- **手感延迟**:按下按键到屏幕响应有明显滞后
- **视觉违和**:子弹明明没打中却被判中,反之亦然
- **作弊空间**:client 自由修改本地状态欺骗 server

netcode 就是处理这套矛盾的**架构性策略集合**。

---

## 2. 基础术语

| 术语 | 含义 |
|---|---|
| **server-authoritative** | 服务器持有"真实"游戏状态,客户端是观察者 + 输入源 |
| **client-authoritative** | 客户端各自跑游戏逻辑,server 只转发(早期 P2P 模式,易作弊,已淘汰) |
| **lockstep / 帧同步** | 所有客户端跑确定性物理,只交换输入。所有人在同一帧看到同一状态(本仓库的 `lockstep_sync_battle` 即此) |
| **state sync / 状态同步** | server 跑物理,定期(20-30Hz)广播完整或增量 state 给所有 client。本仓库 `state_sync_battle` 即此 |
| **patch / snapshot** | server 周期性序列化推送的状态包(Colyseus 默认 patchRate 20Hz / 50ms) |
| **tick / sim step** | server 物理仿真的一步(典型 60Hz / 16.67ms) |
| **RTT** | 往返延迟(round-trip time),从客户端发包到收到 server 回应 |
| **interp delay / 渲染延迟** | client 故意把渲染时间退后一段(50-150ms),用过去时态的真实数据插值,避免 underrun |
| **prediction** | 客户端不等 server 回应,先用本地输入推进 self 状态,后续与 server 仲裁结果对齐 |
| **reconciliation** | server 和 client 预测不一致时的修正:client 接受 server 真相,可能伴随回滚重放未确认输入 |
| **rollback** | 收到对手输入(过去时刻发出)时,client 回滚到那个时刻 + 应用对手输入 + fast-forward 重放到当前 |
| **lag compensation** | server 仲裁命中时,根据 attacker 的网络延迟,把 victim 回滚到"attacker 看到的时刻"判定 |
| **入帧 / 前摇 (startup frames)** | 招式动画从按键到产生攻击判定之间的"无效"帧,常用于掩盖网络延迟 |

---

## 3. 核心方案分类

按"client 如何决定屏幕上的位置"分四类:

### 3.1 Snapshot 直显
- **思路**:client 收到 server snapshot 立即用作渲染位置
- **优点**:实现最简单
- **缺点**:位置以 patchRate 刷新(20Hz),屏幕可见离散跳跃,卡顿严重
- **适用**:从不(纯演示用,生产基本不用)

### 3.2 Snapshot Buffer(延迟渲染插值)— 全员同时基
- **思路**:维护近期 snapshot 队列,渲染时间 = `now - INTERP_DELAY`,在两个真实 snapshot 间 lerp
- **优点**:实现简单,视觉平滑,无作弊空间(client 不参与逻辑)
- **缺点**:**self 也滞后**(操作延迟 = INTERP_DELAY,典型 100ms)
- **适用**:慢节奏游戏、自动化战斗、回合制、走位为主无瞄准

### 3.3 Hybrid(self prediction + others 插值)
- **思路**:self 用本地输入实时推进(0 延迟),others 仍用 snapshot buffer
- **优点**:self 操作零延迟手感,others 平滑
- **缺点**:**self / others 时基不一致**(下文核心讨论),引入 12 类副作用
- **适用**:FPS、MOBA、第三人称动作、大多数 server-authoritative 竞技游戏

### 3.4 Lockstep / Rollback(全员同时基,实时)
- **思路**:client 跑完整确定性物理,只同步输入
- **优点**:全员实时 + 零 desync(在确定性前提下)
- **缺点**:需要确定性物理(浮点、随机数都要确定);任何一方掉线/慢都拖累所有人
- **适用**:2D 格斗(必须)、RTS、需要 8+ 人精确同步的场景

---

## 4. Snapshot Buffer(全员插值)详解

> 本仓库 state-sync 已采用此方案。

### 4.1 工作原理

```
server 推送序列(50ms patchRate):
t=0     t=50    t=100   t=150   t=200
(p0)    (p1)    (p2)    (p3)    (p4)
                                ↑
                  client now=200, render now-100=100

client 渲染时间 = now - INTERP_DELAY
                 = 200 - 100 = 100
                 → lerp(p1@50, p2@100, frac=1.0) = p2
```

每 patch 到达时 push 进 ring buffer;每渲染帧根据 `renderTime` 找跨过该时间的两个 snapshot 做线性插值。

### 4.2 关键参数

| 参数 | 取值 | 理由 |
|---|---|---|
| INTERP_DELAY | 100-150ms | 2-3× patchRate,吸收 jitter + 偶发丢包 |
| Buffer capacity | 8 项(400ms 历史) | 容纳 2× INTERP_DELAY + 缓冲突发延迟 |
| Jump 阈值 | (PLAYER_SIZE × 4)² 像素 | 触发 buffer 重置(respawn / 传送) |

### 4.3 经典失败模式

**早反弹 (Early-bounce)**:如果用 chase 式 lerp(`prev = 当前渲染位置, target = server 最新值`)且 INTERP_DURATION > patchInterval,反弹瞬间(单 patch 内速度反向)的峰值数据被半路 lerp 截断,渲染轨迹永远到不了反弹点 → 球看起来"距墙 20px 提前反弹"。

→ Snapshot buffer 是**结构性修复**:lerp 端点都是真实历史 snapshot,反弹点必经过。

**Buffer underrun**:`renderTime` 越过最新 snapshot ts → hold-at-newest → 那一帧位置不动。原因可能是:
- INTERP_DELAY 太小(< patch 间隔)
- 网络延迟突增导致 patch 迟到
- Schema 字段不变 onChange 不触发 → 静止玩家 buffer 饥饿

**Buffer overrun**:`renderTime` 早于最旧 snapshot → hold-at-oldest。罕见,buffer 够大基本不发生。

### 4.4 Schema 不变不触发 onChange 的坑(Colyseus 0.17 特定)

Colyseus 的 `onChange` 只在字段值真的改变时触发。静止玩家的 `x/y` 在 server 是稳定值,patch 不携带 → client onChange 不触发 → buffer 不进新 snapshot。

**修复**:用 `room.onStateChange`(每 patch 必触发)统一 push,而不是 per-entity onChange。

但这又引出新问题:统一 push 时 ts 都用同一时刻,但 server `spawnBall` 用 `body.position`(物理体当前位置)作起点,而 player schema 还是上一 tick mirror 的旧位置 → ball 起点比 player schema 提前 1 sim step(~3px)→ 视觉上 ball "比 player 抢先"。这是 server 的 mirror 时序问题,不是 client 错。

---

## 5. Self Prediction(客户端预测)详解

### 5.1 工作原理

```
client 帧 N:
  采样输入 input_N
  send(input_N) → server
  立即应用 input_N 到本地 self state(prediction)
  渲染 self 用 prediction state
  渲染 others 用 snapshot buffer(滞后 100ms)

server 收到 input_N(可能是帧 N+5):
  应用 input_N
  下个 patch 推送 self state(带 lastProcessedFrame)

client 收到 server 的 self state:
  比较 prediction vs server truth
  if mismatch:
    reset self to server state
    replay all unconfirmed inputs (N+1, N+2, ...)
    smooth blend 视觉位置(避免硬 snap)
```

### 5.2 必备组件

1. **client 物理副本**:client 必须能用同一份输入 + 同一物理逻辑算出 server 同样的结果
   - **简化模型**:不跑 Matter/Box2D,只算"位置 += dir × speed"。低精度但工程量小,reconciliation 频繁触发
   - **完整复刻**:client 跑独立 Matter world,严格对齐 server 参数。reconciliation 罕见但工程量大
2. **server fixedTick**:必须固定逻辑步长,否则 "client N 帧 input == server 处理" 等式不成立
3. **input 协议带 frame number**:server 报告 `lastProcessedFrame`,client 知道哪些 input 已确认、哪些需要重放
4. **input ring buffer**:client 保留最近 N 帧未确认 input
5. **reconciliation smoothing**:reset 后视觉位置向真值过渡,而非硬 snap(避免抖动)

### 5.3 工程量估计

相比纯 snapshot buffer(本仓库当前实现),完整 prediction 方案:
- server: +10-30% 代码(fixedTick + input queue + lastProcessedFrame schema 字段 + 防作弊 input rate limit)
- client: +50-100% 代码(物理副本 + reconciliation + smoothing + input buffer)
- 测试 / 调试:**复杂度上升数倍**,reconciliation 时序、smoothing 参数、网络条件下的边界情况都需要充分验证

---

## 6. 混合架构的核心痛点:时间差

self prediction + others 插值,两套时基:

```
self 渲染时基:    now (实时,prediction)
others 渲染时基:  now - INTERP_DELAY (滞后 100-150ms)
```

**这个时差是无解的本质矛盾**。所有"解决方案"都是 trade-off:把违和推到玩家感知最弱的角度,或用视觉提示让违和"合法化"。

---

## 7. 12 类时间差具体问题

按严重程度从高到低,分四组:

### 命中 / 碰撞类(竞技公平性)

#### A1. 别人的子弹打中我 — 视觉违和
- 我位置:server_now(prediction)
- 子弹位置:server_now - 100ms
- server 视角:子弹当前帧追上我,命中
- 我的视角:子弹"明显离我老远"我突然死

#### A2. 我的攻击打中别人 — 反向违和
- 别人位置:我看到的是 100ms 前位置
- 我对那个"过去位置"挥拳/瞄准
- server 视角:别人已经走开,落空
- 我的视角:"我明明打到了!"

#### A3. 双方同时攻击的判定矛盾
- A 看 B 100ms 前位置,觉得自己先打中
- B 看 A 100ms 前位置,觉得自己先打中
- server 仲裁取决于选哪个时间基准

### 视觉一致性类

#### B1. 自己撞到别人 — 橡皮筋
- 我冲向别人,看到对方在 (100, 100)
- server 觉得对方在 (110, 100,已走开)
- prediction 让我穿过"我看到的对方",server 修正把我拉回 → 橡皮筋

#### B2. 自己的子弹飞行轨迹
- self 子弹是 prediction(实时)还是插值(滞后)?
- 如果 prediction:子弹朝"过去的他"飞,视觉看似命中,实际擦过
- 如果插值:子弹和 self 不在同一时基,从 self 后方飞出?

#### B3. 子弹被 server 否决的闪烁
- 自己的 predicted 子弹本地立刻渲染
- server 收到 input 后判定冷却没好,不 spawn 真子弹
- client 必须删除已渲染的子弹 → 闪烁

### 因果时序类

#### C1. 死亡瞬间的视觉错位
- self 死亡:server 推到 client → prediction 拉到 spawn 点
- 但杀我的子弹仍在屏幕上 100ms 前位置飞行
- 视觉:"我死了之后,子弹才飞过来"

#### C2. 招式生效顺序乱
- A 视角:A 先发招(t=0),B 后发招(t=10ms)
- B 视角:A 在 B 屏幕上滞后 100ms,B 看到自己先发(t=10ms),A 后发(t=110ms)
- server 视角与某一方一致,另一方违和

#### C3. 重生 / 传送
- self prediction:立即出现在 spawn 点
- 别人看到我 100ms 后才闪现到 spawn
- 短暂窗口 self 已能行动,别人屏幕上我还在 spawn(可能能"打到看不见的我")

### 操作反馈类

#### D1. 摄像机抖动
- camera.startFollow(self)
- self 是 prediction,reconciliation 偶发拉扯
- → 整个屏幕跟着抖

#### D2. 招式命中反馈延迟
- 我打出招式 → server 判命中 → 推回结果 → 我看到命中特效
- 全程 100-150ms,**手感"绵软"**

#### D3. 走位手感与瞄准方向不一致
- self 实时,自己在屏幕上立刻动
- 但 self 看到的"屏幕世界"是 100ms 前的
- 瞄准敌人时,准星指向的是过去的他

---

## 8. 9 种解决方案

### S1. 服务器侧延迟补偿 (Lag Compensation) — FPS 经典

**机制**:server 仲裁命中时,把 victim **回滚**到 attacker 看到的时刻。

```
attacker 在客户端 T_local 时刻射击
attacker 看到 victim 在 (T_local - INTERP_DELAY) 的位置
input 到达 server(再延迟 RTT/2)
server 当前时刻 = T_local + RTT
server 用 victim 在 (T_local + RTT) - RTT/2 - INTERP_DELAY ≈ T_local - INTERP_DELAY 的历史位置判定
→ "favor the shooter"
```

**解决**:A2(攻击落空)
**残留**:A1(我看到子弹老远但中弹)反而更明显 — 因为别人射我时 server 也对我做 lag comp,server 判中时取的是我的 100ms 前位置,但我自己看自己是当前位置。
**经典案例**:CS、Valorant、Overwatch

### S2. 视觉补偿 / 鬼影提示

不解决物理,改用视觉解释:

- 死亡时画一条线"server 报告的命中位置 → 我当前位置",标注 "shooter 看到你在这里"
- 招式落空但 server 判中 → 显示 ghost 动作
- 闪避成功但被命中 → 显示"对手射击点"小标记

**解决**:A1 的玩家挫败感(让违和"可解释")
**代价**:UI 复杂度 + 实时绘制开销
**经典案例**:Overwatch death cam、Apex 死亡回放

### S3. self 渲染层面也滞后

输入处理仍实时,但 self **渲染**用滞后时基:
- 按攻击 → 立即响应输入(prediction 推进逻辑)
- 但 self entity **显示** 100ms 前位置(插值)

**解决**:A1, A2, B1, B2, C 大部分(全员视觉同时基)
**代价**:self 操作"屏幕响应延迟感"
**适用**:RTS、回合制、慢节奏。**FPS / 拳皇绝对不行**。

### S4. Delay-based netcode (输入延迟)

self 输入也加固定 buffer 延迟,所有玩家在同一渲染时基:
- 输入 t=0 → 实际生效 t=100ms
- 全员都看到全员相同滞后的世界
- 物理仲裁完全公平

**解决**:全部命中类问题
**代价**:全员手感"重",所有动作有 100ms 延迟感
**前摇掩盖**:招式前摇 ≥ 100ms 时玩家感知不到 buffer 延迟
**经典案例**:街霸 4、KOF 老网络对战、For Honor、Undisputed Boxing(2024-2025)

### S5. Rollback / Resimulation

server 不动(或 P2P 完全无 server),所有 client 都跑完整物理,**输入到达时回滚 + 重放**:

```
client 帧 N(本地):
  采样输入,立即应用到 self,渲染
  广播输入(带 frame number)给所有对手

client 帧 N+5(收到对手在帧 N 的输入):
  rollback 状态到帧 N
  应用对手帧 N 的输入
  fast-forward 重放帧 N → N+5
  渲染当前帧 = 修正后状态
```

**解决**:全部
**代价**:
- 必须确定性物理(浮点 / 随机数 / 物理引擎都要确定)
- 状态快照机制(每帧保存 N 帧前状态)
- 复杂的状态机设计(招式动画必须可回滚)
- CPU 开销:每次 rollback 重算多帧
**经典名词 / 案例**:GGPO 框架,所有现代 2D 竞技格斗(Street Fighter 6、Tekken 8、Guilty Gear Strive、Skullgirls、Dragon Ball FighterZ、Granblue Versus Rising)

### S6. Self 子弹 prediction

只针对 self 的子弹:
- self 射击 → client 立即 spawn predicted bullet,本地物理飞行
- server 收到 input → spawn 真子弹 → 通过某种 key(owner+frame)匹配 → 替换 predicted bullet

**解决**:B2(子弹飞向我看到的对手位置)、B3(部分,匹配失败仍闪烁)
**代价**:client 必须复刻服务器子弹物理(反弹、TTL、碰撞)
**前提**:子弹运动可预测 — 直线弹道容易,反弹球难

### S7. Death Cam / Replay

死亡时切到对手视角的回放:
- "你被 X 杀死,这是他的视角"
- 回放序列展示 attacker 看到的状态

**解决**:A1 的玩家挫败感
**代价**:游戏节奏被打断(死亡有 2-3 秒回放)
**经典案例**:Overwatch、Apex Legends、CS:GO

### S8. 自适应 INTERP_DELAY

- 弱网下加大 INTERP_DELAY(150-250ms)→ 减小 buffer underrun 概率
- LAN 下减小到 50ms → 减小整体滞后

**解决**:不解决核心时差,但**减小问题严重程度**
**代价**:需要 RTT 估计 + 平滑切换避免抖动
**经典案例**:许多商业 FPS 都有"网络质量自适应延迟"开关

### S9. Time-shifted command (输入带时间戳)

self 输入 message 携带 "我看到的时刻 = T",server 仲裁时不用 server_now 而用 T:
```ts
input_msg = { keys, frame_number, client_render_time: T }
```
server 用 T 仲裁 = 显式 lag compensation。

**解决**:A2 + 部分 A1
**代价**:协议扩展,需要 server-side rollback victim 状态到 T
**与 S1 关系**:S1 是 server 自己根据 RTT 估计 T;S9 是 client 显式告诉 server。后者更准但需要可信 client。

---

## 9. 按游戏类型的方案组合

按游戏特性给完整组合,**每行都是经过工业验证的方案集**:

### 9.1 慢节奏 / 走位为主

例:**坦克大乱斗(本仓库 state-sync battle)**、回合制、卡牌、塔防、农场建造

| 方案 | 用还是不用 |
|---|---|
| Snapshot Buffer 全员插值 | ✅ 主体 |
| Self prediction | ❌ 不需要,100ms 滞后可接受 |
| INTERP_DELAY | 100ms 固定 |
| Lag compensation | ❌ 命中判定不精确,无需 |
| 自适应 delay | ⚠️ 可选优化 |

**关键判断**:玩家是否在"亚秒级反应窗口"做精确决策?走位为主、自动开火、瞄准用 lastDir → 不需要。

### 9.2 顶视角 / 第三人称动作

例:**MOBA(LoL、Dota 2)**、**ARPG(暗黑、流放之路)**、动作 RPG

| 方案 | 用还是不用 |
|---|---|
| Snapshot Buffer for others | ✅ |
| Self prediction(走位 + 普攻起手) | ✅ |
| Lag compensation(技能命中) | ✅ |
| Ghost shot 视觉补偿 | ✅ |
| Self 子弹 prediction | ⚠️ 视技能复杂度,LoL 有,Dota 部分有 |
| Rollback | ❌ 玩家数太多,不可行 |

**核心折衷**:LoL 的"技能延迟感"主要来自 server 仲裁 + 动画前摇,玩家通过预读 + 技能前摇时间适应。

### 9.3 第一人称射击

例:**CS、Valorant、Overwatch、Apex Legends**

| 方案 | 用还是不用 |
|---|---|
| Snapshot Buffer for others | ✅ INTERP_DELAY 50-100ms |
| Self prediction(移动 + 射击瞬间) | ✅ |
| Lag compensation(命中判定) | ✅ favor-the-shooter,**核心** |
| Ghost shot / Death cam | ✅ 缓解被击杀挫败 |
| Self 子弹 prediction(hitscan / 弹道) | ✅ hitscan 立即,弹道带预测轨迹 |
| Self 渲染滞后 | ❌ 绝对不行 |
| Rollback | ❌ 玩家数 + 物理复杂度,不可行 |

**核心折衷**:lag comp 让"我看到 = 我打中",代价是被打方有时"我明明躲了仍中弹"(A1 残留)。Death cam 是合法化这种违和的标准答案。

### 9.4 中重型武器 3D 格斗

例:**For Honor**、**Mortal Kombat**、**Soul Calibur**、**Undisputed Boxing**、**Tekken 联机休闲模式**

| 方案 | 用还是不用 |
|---|---|
| Server-authoritative state sync | ✅ |
| Self prediction(走位 + 招式起手动画) | ✅ |
| Delay-based input buffer | ✅ 利用招式前摇(15-30 帧 / 250-500ms)掩盖 |
| Lag compensation 命中判定 | ✅ |
| 招式前摇 ≥ 2×RTT | ⚠️ 设计要求,招式天然慢 |
| Snapshot Buffer for others | ✅ |
| Rollback | ❌ 状态机太复杂,不实用 |

**为什么能用 state sync**:招式前摇本身就有 250-500ms 的"我无法操作只能等"窗口,网络延迟 100-150ms 完全藏在前摇里。**前提是游戏设计上招式要慢**。

### 9.5 2D 帧精度竞技格斗(经典拳皇风格)

例:**Street Fighter 6、Tekken 8 比赛模式、Guilty Gear Strive、KOF XV、Skullgirls、Dragon Ball FighterZ、Granblue Versus Rising**

| 方案 | 用还是不用 |
|---|---|
| Server-authoritative state sync | ❌ **绝对不用** |
| Self prediction | ❌ 单独不够 |
| Delay-based(单独使用) | ⚠️ 仅作 fallback |
| **Rollback netcode (GGPO)** | ✅ **唯一可行方案** |
| 确定性 lockstep 物理 | ✅ rollback 前提 |

**为什么 state sync 不行**:
1. 最快出招 3-5 帧(50-83ms),前摇时间 < RTT/2,无法掩盖
2. 投技 / 挡反 / 无敌帧窗口 5-12 帧,server 仲裁延迟超过窗口
3. 1 帧误差影响连段成立,带宽 / 延迟容忍度极低

**工业现实**:2025 年 *Hunter x Hunter: Nen × Impact* 因为最初没用 rollback 被社区强烈反对,**推迟发售加 rollback**。这是行业共识。

### 9.6 RTS

例:**StarCraft 2、Age of Empires 4、Company of Heroes 3**

| 方案 | 用还是不用 |
|---|---|
| **Lockstep / 帧同步** | ✅ 主流 |
| 确定性物理 | ✅ 前提 |
| State sync | ❌ 单位数太多带宽爆炸 |
| Rollback | ❌ 单位太多回放 CPU 爆炸 |
| 输入延迟(全员同延迟) | ✅ 200-500ms 普遍接受 |

**核心折衷**:RTS 玩家**预读 5-10 秒后**的战术,200ms 输入延迟无感知。

### 9.7 高玩家数大乱斗

例:**Fortnite、PUBG、Apex Legends 大逃杀模式、Splatoon**

| 方案 | 用还是不用 |
|---|---|
| State sync(分区域 / 视野裁剪) | ✅ |
| Snapshot buffer for others | ✅ |
| Self prediction | ✅ |
| Lag compensation | ✅ |
| **AOI (Area of Interest)** | ✅ 只同步附近 50-100m 玩家 |
| Snapshot 增量编码 | ✅ 减带宽 |

**核心折衷**:大逃杀牺牲一部分"视野外玩家精确状态"换取大玩家数支持。

### 9.8 协作 / 沙盒(无 PVP)

例:**Minecraft、Valheim、Don't Starve Together**

| 方案 | 用还是不用 |
|---|---|
| State sync(简陋实现就够) | ✅ |
| Self prediction(基础移动) | ✅ |
| Lag compensation | ❌ 无需精确命中 |
| 全员同时基 | ⚠️ 视觉违和也无所谓 |

**核心折衷**:无 PVP 时所有同步问题降级为"视觉违和"而非"竞技公平",用户容忍度极高。

---

## 10. 拳皇类格斗游戏:工业现实

(本节专门展开,因为它是最严苛的边界场景。)

### 10.1 历史沿革

| 时代 | 主流方案 | 代表 |
|---|---|---|
| 1990s 街机原版 | 本地双人 | KOF '94-'02 |
| 2000s 早期联网 | Delay-based(P2P) | KOF 2002 UM、街霸 4 |
| 2010s | GGPO 出现 → Rollback 普及 | Skullgirls(2012 首个商业 Rollback)、Killer Instinct(2013) |
| 2020s | Rollback 成行业标配 | Street Fighter 6、Guilty Gear Strive、Tekken 8 |

### 10.2 为什么 state sync + prediction + 前摇掩盖不可行

直接对比 2D 竞技格斗的硬约束:

| 约束 | state sync 可达 | rollback 可达 |
|---|---|---|
| 1 帧精度的输入 / 命中 | ❌ patch 50ms 间隔 | ✅ 帧级精度 |
| 跨地区(100ms RTT)对战 | ❌ 前摇 < RTT 直接破防 | ✅ 完全掩盖 |
| 无敌帧 / armor frame 准确性 | ❌ 仲裁延迟超过窗口 | ✅ |
| 投技 / 挡反时序 | ❌ 仲裁延迟超过窗口 | ✅ |
| 连段精度 | ❌ 累积时序漂移 | ✅ |

### 10.3 即使是"简化版 2D 动作格斗"也建议 Rollback

如果游戏:
- 招式前摇 < 6 帧(< 100ms)
- 玩家精读对手起手时机
- 跳取消 / 连段是核心机制

→ **必须 Rollback**。

如果游戏:
- 招式前摇 ≥ 8 帧(≥ 130ms)
- 走位 + 大招型,精确连段不重要
- 玩家容忍 100ms"动作偏重感"

→ State sync + delay-based 可以试,**但找不到知名先例**(2025 年搜索结果)。

### 10.4 Rollback 与 Colyseus 的不兼容

本仓库的 Colyseus state-sync 架构**不能直接做 rollback**:
- Colyseus 是 server-authoritative,client 不跑物理
- Rollback 要求 client 跑完整确定性物理 + lockstep
- 本仓库的 lockstep 场景是另一套架构

如果要做拳皇类玩法,选择只有:
1. 用 **lockstep 场景架构**(本仓库已有)+ 加 rollback 层
2. 完全独立项目,不复用 state-sync 基础

---

## 11. 本仓库当前选型与演进路径

### 11.1 当前 state-sync battle 选型

- **核心**:Snapshot Buffer 全员插值
- **INTERP_DELAY**:100ms
- **patchRate**:Colyseus 默认 50ms
- **不做** prediction(规则上自动开火 + 走位主导,不需要)
- **不做** lag compensation(命中判定模糊)
- **debug overlay** 监控 fps/ping/patch_avg/patch_std/entities/mem

### 11.2 预定义的演进路径(按规则变化触发)

| 玩法变化 | 触发的方案升级 |
|---|---|
| 加手动瞄准 | self prediction + lag comp + ghost shot |
| 加近战连段(< 200ms 反应) | 切换到 lockstep + rollback,放弃 state sync |
| 加大地图(50+ 玩家) | AOI + 增量 patch |
| 弱网优化 | 自适应 INTERP_DELAY,基于 RTT 动态调整 |

### 11.3 当前 lockstep battle 场景的潜在升级方向

如果未来要支持竞技 2D 格斗:
- 在 lockstep 场景基础上加 rollback 层
- 引入帧编号 + 状态快照(每帧保存)
- 收到对手输入(过去帧)→ rollback + 重放
- 工程量预估 3-6 人月

### 11.4 残余问题(已知)

- **球反弹时机微抖**:server `Matter.Engine.update(deltaTime)` 用 wallclock dt,sim step 抖动 ±5px
- **修复方向**:server fixedStep(本仓库实测过,体验**不如**全员插值,已回退)
- **当前结论**:client 全员插值是当前最佳选择,继续观察是否还需要 server 端优化

---

## 12. 参考资料

### 行业经典文章
- [Netcode in Fighting Games — infil](https://words.infil.net/w02-netcode-p3.html) — 格斗社区经典系列
- [Source Multiplayer Networking — Valve Wiki](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) — FPS lag comp 参考实现
- [Overwatch GDC: Networking Scripted Weapons and Abilities](https://www.youtube.com/watch?v=W3aieHjyNvw)
- [GGPO Developer's Guide](https://github.com/pond3r/ggpo/tree/master/doc) — Rollback netcode 框架文档
- [Fast-Paced Multiplayer — Gabriel Gambetta](https://www.gabrielgambetta.com/client-server-game-architecture.html) — 入门教程

### 引擎 / 框架
- **Colyseus** — 本仓库使用的 state sync 框架(Node.js)
- **GGPO / GGRS** — 业界 Rollback 标准库
- **Mirror / Photon Fusion** — Unity 端 server-authoritative + prediction 框架
- **Nakama** — 通用游戏后端,支持多种同步模式

### 案例研究
- For Honor 的网络架构演进(育碧多次 GDC 演讲)
- Hunter x Hunter Nen × Impact 因 rollback 缺失推迟发售(2024-2025)
- Skullgirls 早期 GGPO 集成案例
- Tekken 8 Rollback 实现(Bandai Namco GDC 2024)

### 相关本仓库代码
- `example-proj-client/src/util/snapshot_buffer.ts` — 当前 buffer 实现
- `example-proj-client/src/util/debug_overlay.ts` — 监控 overlay
- `example-proj-client/src/scenes/state_sync_battle_scene.ts` — state sync 场景
- `example-proj-client/src/scenes/lockstep_sync_battle_scene.ts` — lockstep 场景(rollback 升级起点)
- `example-proj/src/servers/battlesvr/rooms/state_sync_battle_room.ts` — 服务器权威物理
