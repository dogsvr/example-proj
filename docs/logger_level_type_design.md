# Logger Level 类型放置的方案对比

> 起点问题:pino-based `@dogsvr/logger` 里的 `Level`(即 `pino.LevelWithSilent`)——这个"日志级别值集合"类型,合理归属应当在哪一层?
>
> 项目**最初实现**把 `Level` 定义在了 core(`@dogsvr/dogsvr`)里,即本文所称的**方案 E**。后来重新审视时意识到两个问题:
>
> 1. **core 实际不需要关心 log level 的具体值集合**——它通过 `LoggerImpl` 只钉死了 6 个 severity method 名(方法契约),不该越权钉死 level 字符串集合(值集合)。
> 2. **不应由 core 限制 level 定义**——具体 level 值集合是 impl 决定的,`silent` 是 pino 的选择,不同 impl 可以有不同选择。让 core 定义 = 强制未来所有 impl 遵循 pino 的值集合。
>
> 基于这两点,决定把 `Level` 从 core 撤出,由 impl(`@dogsvr/logger`)定义并出口,业务侧从 impl 直接 import。这是**当前实现**,即本文所称的**方案 F**。
>
> 本文档记录当时讨论过程中考察的 6 类方案、横向对比、以及"从 E 到 F 重构"的决策理由。目的是把这次 abstraction 抉择留档,后续遇到同类问题(某个 impl-specific 类型是否该上升到 core)可参照。

## 目录

1. [背景](#1-背景)
2. [问题域](#2-问题域)
3. [方案 A:Core re-export impl 类型](#3-方案-acore-re-export-impl-类型)
4. [方案 B:Core 定义弱类型 Level](#4-方案-bcore-定义弱类型-level)
5. [方案 C:抽第三方 shared 类型包](#5-方案-c抽第三方-shared-类型包)
6. [方案 D:Registry pattern(declaration merging)](#6-方案-dregistry-patterndeclaration-merging)
7. [方案 E:Core 定义强类型 Level(初始实现)](#7-方案-ecore-定义强类型-level初始实现)
8. [方案 F:业务侧从 impl import(当前实现)](#8-方案-f业务侧从-impl-import当前实现)
9. [横向对比表](#9-横向对比表)
10. [选定方案与结论](#10-选定方案与结论)
11. [从 E 迁移到 F 的决策复盘](#11-从-e-迁移到-f-的决策复盘)
12. [可复用的判断经验](#12-可复用的判断经验)

---

## 1. 背景

### 1.1 dogsvr polyrepo 的 logger 分层

按 `CLAUDE.md` 的 Polyrepo Layout,项目里和 logger 相关的三层是:

| 层 | 包 | 定义了什么 |
|---|---|---|
| Framework core | `@dogsvr/dogsvr` | `LoggerImpl` / `Log` interface(6 个 severity method + `child` + `flush?`);`registerLogger`;`log` proxy;`LogConfig { enabled: boolean }` |
| Logger impl | `@dogsvr/logger`(pino-based) | 开放扩展点——`LoggerImpl` + `registerLogger` 就是标准 plugin 契约,用户可基于其它底层库(winston / bunyan / 自研)写新 impl。当前项目内实现是 pino-based:`SetupOptions`;`Level = pino.LevelWithSilent`;central / inline 两种模式 |
| Business | `example-proj` | 消费 core 的 `log`,启动阶段调选定 impl 的 `setupLogger` / `setupLoggerInWorker`;通过 `otel_config.ts` 定义业务侧 config schema |

依赖方向:`@dogsvr/logger` **单向依赖** `@dogsvr/dogsvr`(logger 实现要 `registerLogger` / `getSpanSink` / `onShutdown`);core 对具体 logger impl 一无所知,通过 `LoggerImpl` 接口做依赖倒置。这是本次讨论的**依赖方向前提**,任何方案都不应破坏它;同时 impl 层是**开放扩展点**——虽然单进程运行时只激活一个 impl(`registerLogger` 生效一次),但生态层面允许多个 impl 包并存,不同项目各选其一。

### 1.2 为什么讨论 Level 归属

Level 归属这个问题不是凭空冒出来的,是从两个具体现象反推出来的:

**现象一(worker 入口 3 处)**:
```ts
// example-proj/src/{zonesvr,dir,battlesvr}/*_logic.ts:3
import { setupLoggerInWorker, type WorkerInitPayload, type Level } from '@dogsvr/logger/worker_thread';
```
每个 worker 都从 `@dogsvr/logger` 拉出 `Level` 类型,只为了给 `ZoneSvrConfig.log.level` 标注类型。三处重复,业务侧显式依赖 impl 类型。

**现象二(business config schema 一处)**:
```ts
// example-proj/src/shared/otel_config.ts LogConfigExt.level 定义位置
export interface LogConfigExt extends LogConfig {
    endpoint?: string;
    level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}
```
业务侧手写了一遍 pino 的 level 联合。这份字面量是**没有链接到权威定义的孤本**,pino 若增删 level(概率极低但非零)不会自动同步。

由这两个现象反推,可以问的问题是:是否应该由 core 出口 `Level`?或者用其它机制解耦?各方案会带来哪些新的耦合或成本?

## 2. 问题域

抽象出一个更广的问法:**当一个类型 T 逻辑上跨越 core 和 impl 两层,应该住在哪?**

四种候选归属:

1. 住 core,由 core 定义。
2. 住 impl,由 impl 定义,业务直接从 impl import。
3. 住 impl,由 core "反向出口"(reexport)。
4. 住 impl,通过 registry / declaration merging 由 core "间接暴露"。

后两种候选的动机是"让业务代码只依赖 core"——把业务对 impl 的显式依赖降到零。下面 §3–§8 逐一评估。

## 3. 方案 A:Core re-export impl 类型

### 3.1 形态

```ts
// dogsvr/src/main_thread/index.ts
export type { Level } from '@dogsvr/logger/main_thread';
```

### 3.2 结构性障碍(fatal)

- `@dogsvr/logger` 已经 depend on `@dogsvr/dogsvr`(`registerLogger` 等 API 从 core 拉)。
- 加这行,`@dogsvr/dogsvr` 的 `package.json` 得反向 depend on `@dogsvr/logger` 才能类型解析。
- **形成 package-level 循环依赖**。npm install 能装(node_modules 支持 cycle),但下面几件事都会崩:

| 环节 | 症状 |
|---|---|
| Build 顺序 | tsc 编 dogsvr 需要 logger 的 `.d.ts`,tsc 编 logger 需要 dogsvr 的 `.d.ts`。CI 里两个包各自 `rm -rf dist && tsc` 会 fail。 |
| Publish | 先发哪个都会引用未发布版本;一次全量升级极难协调。 |
| 本地开发 | `npm link` 双向链需要手工小心;IDE 有时能解一有时不能。 |
| Polyrepo 约定 | `CLAUDE.md` 明确"每个子目录独立 `npm run build`",本方案直接违反。 |

### 3.3 结论

**技术不可行**,不用继续评估收益侧。

## 4. 方案 B:Core 定义弱类型 Level

### 4.1 形态

```ts
// dogsvr core
export type Level = string;   // 或 unknown
export interface LoggerImpl {
    isLevelEnabled(level: Level): boolean;
    ...
}
```

### 4.2 评估

Core 承认"我不知道具体 level 集合是什么",定义得很弱。

- **依赖方向 OK**:core 不依赖 impl。
- **但没解决问题**:业务侧 `LogConfigExt.level` 若标 `Level = string`,又变成任意字符串,`"warning"` 拼错也不会被 TS 拦。
- 想拿到严格 7-value 联合,业务还是必须 import impl 的类型。等于什么都没做。

### 4.3 结论

**不解决问题**。

## 5. 方案 C:抽第三方 shared 类型包

### 5.1 形态

新增一个类型专用包:

```
@dogsvr/logger-types  (定义 Level, LoggerImpl 等类型契约)
   ↑             ↑
   dogsvr      logger
```

两个包都 depend 这个新包,循环消解。

### 5.2 评估

- **技术可行**:cycle 打破了。
- **但对当前 polyrepo 成本很高**:每包独立 git repo,新包=新仓库=新 CI=新 publish 流程。同步一次 breaking change 要跨三个仓库。
- **shared 包能装什么值得放的东西?**——`LoggerImpl` interface 属于框架级抽象,已由 core 承担;`Level` 值集合是各 impl 自己的选择(pino 用 `silent`,winston 用 `silly`/`verbose`),放 shared 包会强制所有 impl 共用同一份 Level 定义,反而让 impl 失去自主。所以 shared 包对 `LoggerImpl` 层次的抽象合理但已由 core 覆盖;对 `Level` 而言不合理。
- **收益幻觉**:即便真放进 shared 包,shared 包本质上仍是**由抽象方定义,而不是 impl 定义**——把责任从 core 换成 shared 包,值集合的责任错位问题(见 §7.3)没解决。

### 5.3 结论

**当前场景规模不匹配、过度设计**;而且分不到 shared 包的合理内容——`LoggerImpl` 已在 core,`Level` 应由 impl 自持。

## 6. 方案 D:Registry pattern(declaration merging)

### 6.1 形态

Core 声明一个空 slot interface(canonical declaration 放 `common/`,两个入口都 re-export 它),`Level` 从 slot 派生;impl 通过 declaration merging 往 slot 里填内容。

```ts
// dogsvr/src/common/logger_types.ts  ← canonical declaration
export interface LoggerLevelRegistry {}
export type Level = keyof LoggerLevelRegistry extends never
    ? string                                         // 空 registry fallback,防止业务代码类型全塌
    : LoggerLevelRegistry[keyof LoggerLevelRegistry]; // T[keyof T] 取 value union

// dogsvr/src/main_thread/index.ts
export type { LoggerLevelRegistry, Level } from '../common/logger_types';

// dogsvr/src/worker_thread/index.ts
export type { LoggerLevelRegistry, Level } from '../common/logger_types';
```

Impl 侧只需 augment 一次(挂到 canonical 上,两个 subpath 共享):

```ts
// @dogsvr/logger/src/main_thread/index.ts
declare module '@dogsvr/dogsvr/main_thread' {
    interface LoggerLevelRegistry {
        pino: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
    }
}
```

Business 侧从任一 subpath 拿 `Level`,得到的都是 impl 填进去的 union:

```ts
import type { Level } from '@dogsvr/dogsvr/main_thread';    // 'trace' | ... | 'silent'
import type { Level } from '@dogsvr/dogsvr/worker_thread';  // 同上,canonical 共享
```

**Level 派生的机制**:`keyof LoggerLevelRegistry` 得到 key 集合(单 impl 时是 `'pino'`,即使只有一个 key 也没问题);`LoggerLevelRegistry[keyof T]` 用 indexed access 取 value——**Level union 藏在 value 里**,不在 key 里。多 impl 场景下 TS 把 `T['pino' | 'winston']` 分发为 `T['pino'] | T['winston']`,自动 union 合并——这就是 registry 的多态性来源。空 registry 时 `keyof {} = never`,条件命中,fallback 到 `string`。

### 6.2 生态先例

Registry pattern 是 TS 生态里成熟的扩展点设计,不是奇技淫巧:

- **React** — `JSX.IntrinsicElements`。React 定义空 interface,自定义 element 库 augment 进去。
- **Redux Toolkit** — `ThunkMiddleware` / `Reducer` 类型注册。
- **Vue** — `ComponentCustomProperties`。plugin 注册 `$router` `$store` 到 `this` 类型。
- **TanStack Router** — `Register` interface,app 侧 augment 让 route path 变字面量类型。
- **CSS-in-JS 库** — theme 类型的 augmentation。

### 6.3 依赖方向

- Core 拥有 slot(接口所有权)。
- impl 通过 `declare module` augment 填内容。
- 依赖方向没反(core 不依赖 impl 的运行时,只暴露一个可被扩展的 interface)。

**关于多入口的补充**:`@dogsvr/dogsvr/main_thread` 和 `worker_thread` 是两条 subpath,但只要 `LoggerLevelRegistry` 在 core 内部作为**同一个 canonical declaration**(在 `common/logger_types.ts` 里定义,两个入口 re-export),impl 只需 `declare module '@dogsvr/dogsvr/main_thread'` augment 一次。TypeScript 把 augment 挂到 canonical interface 上,worker_thread 侧的 re-export 自动共享。业务从任一 subpath import `Level` 都能看到 impl 填的 union——**不需要 impl 侧写两遍 augment**。

### 6.4 四个陷阱

| 陷阱 | 说明 |
|---|---|
| **augment 依赖"被看见"** | `.d.ts` 只在被 TS program 加载时生效。business 若从没 `import ... from '@dogsvr/logger/*'`,Level 会 fallback 到 `string`。dogsvr 场景 business 一定会 import(setupLoggerInWorker 是函数,躲不掉),但**是脆的隐式契约**。 |
| **discovery 差** | reader 看到 `type Level = keyof LoggerLevelRegistry extends never ? string : ...`,不看 augment 处根本不知道实际 union 是什么。IDE 能跳但要点两下,新人容易懵。 |
| **多 impl union 合并**(不是替换) | 若类型层同时看得到两个 impl 的 augment(比如 devDep 里都装了),`Level = union1 \| union2`。dogsvr 单进程运行时只激活一个 impl,`registerLogger` 一次生效——类型层 union 与运行时激活的 impl 不匹配,类型偏宽,业务代码可能标注 pino 里没有的 winston 值仍能编译过。 |
| **多态性和实际使用不匹配** | Registry 的价值在于"哪个 impl 装载,业务见到的 Level 就是哪个"。但业务侧 `import type { Level } from '@dogsvr/logger'` 已经能达到同样效果:选定哪个 impl 就 import 哪个 impl 的 Level,单向依赖清晰。Registry 提供的"通过 core 名义间接暴露"是绕远路。 |

### 6.5 什么场景 registry 才合适

**当 app 层可以贡献 core 无法预知的类型,且这些类型来自 app 侧而非 impl 侧**:

- React:任何用户自定义组件都可能 augment `JSX.IntrinsicElements`。
- TanStack Router:每个 app 的 route tree 是独一的字面量类型。
- Vue plugin:`$store` 从哪来 core 完全不知道。

dogsvr Level 场景不同:

- Level 定义**由 impl 提供**,不是 app 层贡献。
- 单进程只激活**一个** impl,业务选定后从选定 impl 直接 import Level 更朴素、单向依赖清晰。
- Registry 的"多个 augment 汇入 core slot"多态性,与"业务只认一个 impl"的实际使用模式不匹配。

### 6.6 结论

**技术可行、设计合理,但适用场景不匹配**。Registry 的多态性对 app 层贡献类型的场景(React/Vue)是刚需,对"impl 是开放扩展点、单进程只激活一个 impl"的 dogsvr 场景是绕远——业务从选定 impl 直接 import 是更朴素路径。

## 7. 方案 E:Core 定义强类型 Level(初始实现)

### 7.1 形态

```ts
// dogsvr/src/common/logger_types.ts
export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface LoggerImpl {
    ...
    isLevelEnabled(level: Level): boolean;   // 收窄
    ...
}
```

Core 直接把 pino 隐含的 severity 层次显式化。zero import,纯字面量 union。

**这是本项目最初实现的方案**——一段时间内 `Level` 定义在 core,业务从 `@dogsvr/dogsvr` import。后来意识到 §7.3 的两个根本性缺陷,才决定迁移到方案 F。

### 7.2 表面上的 4 条优点

- **收紧 `LoggerImpl.isLevelEnabled(level: string)`**:目前 `string` 存在类型漏洞,收窄后拼错(如 `"warning"`)会被 TS 拦。
- **业务侧一处 leakage 消除**:业务侧手写 union 可以改成 `level?: Level`,不再有 drift 风险。
- **schema 对称**:`LogConfig.level?: Level` 加进 core,与 metrics/traces 抽象层次对齐。
- **抽象方向一致**:core 定义 Level,impl 实现 → 与 core 已有的 `LoggerImpl / MetricSink / SpanSink` 完全一致。

### 7.3 两个根本性缺陷(触发从 E 迁移到 F 的直接原因)

**缺陷 1: core 不需要关心 log level 的具体值集合**

Core 已经通过 `LoggerImpl` 的 6 个 method(trace/debug/info/warn/error/fatal)钉死了 severity 层次——**这是方法契约**。impl 必须实现这 6 个 method,能力已足够。

`Level` 是**值集合**——具体 level 字符串是什么("silent" / 是否包含 "warn" 而不是 "warning" 等)。这属于 impl 内部约定,是 pino 选择的字符串命名。

Core 不用调用 `isLevelEnabled` 做什么业务判断,不读 `LogConfig.level`,也不 dispatch 到具体 method。**core 侧没有代码从"知道具体 Level 值"里获益**——但它却承担了"定义 Level 值集合"的责任。这是**责任错位**。

**缺陷 2: core 不应限制 level 定义**

`LoggerImpl` + `registerLogger` 的 plugin 契约本身就是**开放扩展点**——用户可以基于 winston / bunyan / 自研写新 impl,注册进来即可替代 pino。这是架构预留的合法未来,不是 hypothetical。

但一旦 core 定义 `Level = 'trace'|...|'silent'`,所有 impl 都被强制:

- 必须支持这 7 个字面量,不能少。
- 不能加自己的 level(比如 winston 的 `verbose`、`http`、`silly`;syslog 的 `notice`、`crit`)。
- 不能改字符串命名。

但 level 值集合本质上是**每个 impl 自己的选择**:

- pino 选择 `silent` 表示"关闭输出",bunyan 通过流控机制表达同样语义。
- winston 的 `silly` / `verbose` / `http` 完全不在 pino 的集合里。
- 换新 impl 后,`silent` 不一定还在;core 定义会直接违反 `LoggerImpl` 契约的开放性。

强行让 core 拥有"值集合定义权"= **让抽象层越权钉死实现细节**,同时**违反 impl 开放扩展的架构承诺**。

### 7.4 附加成本

**Cost 1: duplicate source of truth**

pino 有 `LevelWithSilent`(权威),core 独立定义 `Level`,两处并存。TypeScript 结构等价性能让它们互相 assign,但**语义上是两份**——pino 若增删 level 不会自动同步。

**Cost 2: API 表面扩张**

每个 core 的 export 都是维护成本、都是版本兼容承诺。加一个字面量 union 看似便宜,但要写文档、要保证 breaking change 讨论时被记得、要 CHANGELOG。

**Cost 3: §7.2 的 4 条表面优点绝大多数是虚的**——详见 §11.3。

### 7.5 结论(最初为什么选它、为什么放弃)

E 的表面优点(§7.2)在缺陷(§7.3)与成本(§7.4)面前净值为负——core 不该关心也不该限制 impl 的 level 值集合。这是从 E 迁移到 F 的直接原因;完整决策过程见 §11。

## 8. 方案 F:业务侧从 impl import(当前实现)

### 8.1 形态

`Level` 定义在 `@dogsvr/logger`(re-export 自 `pino.LevelWithSilent`),core 不参与。业务侧凡需 Level 类型的地方,直接从 `@dogsvr/logger/{main_thread,worker_thread}` import。

### 8.2 依赖分析

- 业务本来就依赖 `@dogsvr/logger`(worker 三处 `setupLoggerInWorker` 是必要 API,不可能挪走)。
- 从这个已有依赖里额外拿一个 `Level` 类型,**没有引入新的耦合**。
- pino 的 `LevelWithSilent` 是**唯一权威**,`@dogsvr/logger` re-export,业务用——单向依赖链,零 drift。
- Core 保持 zero-dep,`LoggerImpl.isLevelEnabled(level: string)` 保持宽松签名——正确,因为 core 不该管 impl 的 level 集合。

### 8.3 优点

- **消除业务侧手写 union 造成的 duplication**(手写 union → import Level)。
- **不需要改 core / 改 impl**,只是订正业务侧引用位置。
- **依赖方向清晰**:业务依赖 impl(它本来就依赖),impl 依赖 core,core 独立。
- **正确切分抽象层次**:`Level` 值集合(哪些字面量)是 pino 的实现细节,和 core 抽象的 severity 层次(哪些 method 名)是不同层次。前者是 impl 细节,后者是 core 契约,不该混。
- **impl 保留 level 定义权**:未来若换 impl,各家自己决定 level 集合,core 不阻塞。

## 9. 横向对比表

| 维度 | A. Core reexport | B. Core 弱类型 | C. Shared 包 | D. Registry | E. Core 强类型(初始) | **F. impl-owned(当前)** |
|---|---|---|---|---|---|---|
| 循环依赖 | ✗ package cycle | ✓ | ✓ | ✓ | ✓ | ✓ |
| Build 独立 | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Core zero-dep | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Core 是否越权定义值集合 | 是(re-export 亦是持有) | 弱化了不算 | shared 包代持,同越权 | 让 impl 填 | ✗ 越权 | ✓ 未越权 |
| Impl 保留 level 定义权 | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ |
| Discovery | 中 | ✓ | 中(跨包跳) | ✗(需跳 augment) | ✓ | ✓ |
| Duplication | 0 | 1(未消) | 0 | 0 | 0,但引入 core-vs-pino 双 source | **0** |
| 新增架构复杂度 | 高 | 无 | 高(新包新仓库) | 中(augmentation) | 低 | **无** |
| 净值 | 不可行 | 不解决问题 | 过度设计 | 场景不匹配 | 越权 + 责任错位 | **最优** |

## 10. 选定方案与结论

**当前实现**是方案 F:`Level` 由 `@dogsvr/logger` 定义(re-export 自 pino 的 `LevelWithSilent`),业务侧凡需类型标注处直接从 impl 包 import;core 不定义、不出口 `Level`。选择理由见 §8.3;从方案 E 迁移的过程见 §11。

方案 F 的取舍:业务代码显式承认对 impl 的类型依赖。这不是缺点,而是**如实反映依赖关系**——业务用具体 logger impl 的时候,认识 impl 的类型是自然的。试图通过 core reexport / registry 等机制把这个认识"抽象掉",反而带来循环依赖、责任错位、多出定义源等问题(见方案 A/D/E)。

## 11. 从 E 迁移到 F 的决策复盘

本节记录本项目实际经历的两次决策——**为什么最初选 E**、**当时 miss 了什么**——以及重构过程中重新审视的判断依据。留档目的是让未来遇到同类"impl-specific 类型是否上升到 core"的抉择时,有可参照的推理链。

### 11.1 最初为什么定在 core(方案 E)

早期实现里 `Level` 定义在 `@dogsvr/dogsvr` core,业务从 core import。理由是当时的判断:

- **对齐已有 core 抽象**:core 已经通过 `LoggerImpl / Log / MetricSink / SpanSink` 定义了框架级契约,`Level` 看起来是同一层次的东西——既然都是"日志相关的核心概念",放 core 显得对称。
- **业务只依赖 core 的直觉洁癖**:让业务代码不认识具体 impl 的类型,看似能减少耦合。
- **收紧类型的顺带收益**:`isLevelEnabled(level: string)` 收窄成 `isLevelEnabled(level: Level)` 是免费的类型防御。

当时忽略了两件事:impl 是**开放扩展点**(§1.1);Level "值集合"和 severity "方法契约"是**不同抽象层次**(§7.3 缺陷 1)。这两点让 §11.1 的三条理由都站不住,详见 §11.3。

### 11.2 重新审视时暴露的两个根本问题

参见 §7.3。简言之:

1. Core 里没有代码消费 `Level` 值集合,承担了不该承担的责任(责任错位)。
2. Core 定义 Level 强制所有 impl 遵循 pino 的字面量集合,违反 `LoggerImpl` + `registerLogger` 的开放扩展契约。

这两条不可绕开,是从 E 迁移到 F 的直接原因。

### 11.3 §11.1 三条支撑理由的复评估

- **"对齐 core 抽象"是错觉**。`LoggerImpl` 6 method 名是**方法契约**;pino 的 `LevelWithSilent` 是**值集合**。前者归 core、后者归 impl,不同层次不该混。
- **"业务只依赖 core"是幻觉**。业务必须 import `setupLoggerInWorker`(函数)与 `WorkerInitPayload`(类型),Level 从哪拿都不改变对 `@dogsvr/logger` 的依赖——不构成有意义的解耦。
- **"收紧 isLevelEnabled"是 speculative 收益**。没有已知 bug,`isLevelEnabled` 年调用几次;不足以支撑架构决策。

### 11.4 迁移到 F

结论清晰后动手:

- 从 `@dogsvr/dogsvr` 撤出 `Level` 定义,收回 `LoggerImpl.isLevelEnabled(level: string)` 的宽松签名。
- `Level` 由 `@dogsvr/logger` 定义并出口(re-export 自 pino 的 `LevelWithSilent`)。
- 业务侧凡需类型标注处从 `@dogsvr/logger/{main_thread,worker_thread}` import。
- 消除业务侧手写 union(把字面量并集换成 `import type { Level }`)。

方案 F 落地后:core 恢复 zero-dep 与责任聚焦;impl 保留 level 定义权;业务显式承认对 impl 的类型依赖(这本来就是事实)。

### 11.5 元层次教训

- **对称性不是免费的**。看似"和 metrics/traces 抽象对齐"的选择,若不解决实际问题,就是在错误方向上追求整齐,代价是越权和责任错位。
- **重构决策要对**接口的所有权来源**追问一步**——不是"这个类型看起来属于 core 层"而是"core 里有代码在消费它吗?若没有,这个类型可能只是名字听起来核心"。

## 12. 可复用的判断经验

Checklist,套用到"某个 impl-specific 类型是否该上升到 core"的抉择上:

1. **依赖方向优先**——若上升会造成 package-level 循环依赖(方案 A),一票否决。
2. **消费者在哪**——core 加一个 export 后,**core 自己有代码从中受益吗**?若没有,是审美收益。
3. **抽象层次不要混**——方法契约(有几档 severity、名字是什么)归 core,值集合(具体字符串怎么写)归 impl。方案 E 的错误就是把值集合抬到了方法契约层。
4. **验证"业务不依赖 impl"的真伪**——若业务对 impl 的其它 API 已经必须依赖,单挪一个 type 是伪去耦。
5. **消除 duplication 前先数 sources of truth**——不能为了消除 1 处,引入 2 处。
6. **registry 判定看多态性能否兑现**——多个来源真正需要合并输出时才用(React/Vue);单激活场景直接从选定 impl import 更朴素(方案 D vs F)。
7. **最简改动优先**——若业务侧 import 位置调整能解决,不动 core / impl。改后者是 breaking change 或 API 表面扩张,只有业务侧改不动时才该考虑。
