# omp-roundtable：域证据

[omp-roundtable.md](omp-roundtable.md) §1 的附件。下表记录各条域性质的证据。

- 宿主版本：omp 18.4.4，安装在 `~/.bun/install/global/node_modules/@oh-my-pi/`。
- 路径缩写：`CA` 指 `pi-coding-agent/src`，`PKG` 指 `pi-coding-agent/package.json`。
- 除非标明「探针」，下表的证据都来自源码。

## omp 宿主

| 性质 | 证据 |
|---|---|
| 子 agent（普通、隔离、孙级）都在同一个 OS 进程里运行；隔离只改变工作树，不另开进程 | `CA/task/executor.ts:3470-3475,4039-4042`；`CA/task/isolation-runner.ts:432-452` |
| 插件的工厂函数在每个会话绑定时各执行一次。根会话只导入一次插件模块，并把已准备好的工厂转交给非隔离子 agent，子 agent 只重新绑定、不重新求值模块，所以与父会话共享模块实例。隔离子 agent 清空这些预加载后重新导入，每次导入带新的 `?mtime=<tag>`，于是各得一份模块实例。席位按 spawn 票据都以 `isolated: true` 派出，因此模块顶层状态在席位之间不共享；进程内共享的状态放在 `globalThis` 的 `Symbol.for` 槽位里。经包路径导入的宿主单例（如 `AgentRegistry`）仍然共享 | `CA/extensibility/extensions/loader.ts:480-518,555-563`；`CA/sdk.ts:2530-2553`；`CA/task/isolation-runner.ts:436-441`（`preloadedExtensionPaths`、`preloadedPreparedExtensions` 置为 `undefined`）；`CA/extensibility/plugins/legacy-pi-compat.ts:2622-2630`（`import(\`${entrySpecifier}?mtime=${nextLegacyPiLoadTag()}\`)`）。探针（#4 端到端运行）：主会话已召集议程，隔离派出的 owner 席位的模块实例却报告「本进程当前没有进行中的议程」 |
| 只有通过包路径导入（例如 `@oh-my-pi/pi-coding-agent/registry/agent-registry`）才能拿到 CLI 运行时的单例；用绝对路径导入源码会得到另一份单例 | 探针：包路径导入时输出 `registry= Main`，绝对路径导入时输出 `registry= missing`；`PKG:56-64` |
| `ctx.agent` 提供 `kind`、`id`、`name`、`depth`、`parentId?`，工具的 `execute` 和 `pi.on` 的处理函数都能拿到 | `CA/extensibility/extensions/types.ts:435-455,458-492,679-686,1314-1315`；`CA/sdk.ts:3225-3242` |
| 插件注册的工具默认对子 agent 可见，除非会话设置了 `restrictToolNames`，或工具声明了 `hidden` / `defaultInactive` | `CA/sdk.ts:3279-3299,3914-3950` |
| 声明 `defaultInactive: true` 的工具注册后不在初始工具集里；注册它的插件用 `pi.setActiveTools` 在自己绑定的会话里打开或关闭它。宿主自带的 autoresearch 模式就是这样：`/autoresearch` 命令打开实验工具，退出时再关闭 | `CA/extensibility/extensions/types.ts:647-655`；`CA/sdk.ts:3914-3950`；`CA/autoresearch/index.ts:93-103,125-218` |
| 插件用 `pi.registerCommand(name, {handler})` 注册 `/name` 命令；处理函数拿到的 `ctx` 带 `agent` 与 `ui.notify` | `CA/extensibility/extensions/types.ts:241-264,458-492,578-583,1303-1308,1491-1499` |
| `tool_call` 钩子在调用者自己的会话里执行，可以返回 `{block, reason}` 拦截调用；处理函数出错时按拦截处理 | `CA/extensibility/extensions/wrapper.ts:247-294`；`CA/extensibility/shared-events.ts:310-318` |
| `context` 钩子在每次主循环模型请求前执行，接收并返回 `{messages}`；在主会话和子会话中都会执行；追加的消息只用于本次请求，不写进会话历史 | 源码：`CA/extensibility/shared-events.ts`（`context` 事件）。探针：compact 之后抓到的下一次请求体里带着注入的标记 |
| `sendUserMessage` / `sendMessage` 只作用于该绑定所在的会话：会话存活且空闲时会启动一轮，正在运行时会排队；会话 parked 之后旧绑定失效，aborted 时不可投递 | `CA/extensibility/extensions/types.ts:1564-1572`；`CA/modes/runtime-init.ts:56-98`；`CA/session/agent-session.ts:8203-8240,8290-8387,8406-8451`；`CA/irc/bus.ts:97-184`；`CA/task/executor.ts:3313-3317,4085-4126` |
| parked 的席位被恢复后会重新执行插件绑定，所以要在新会话的 `session_start` 里刷新绑定 | `CA/irc/bus.ts:122-162`；`CA/registry/agent-lifecycle.ts:334-418`；`CA/task/executor.ts:4085-4126`；`CA/modes/runtime-init.ts:35-43,159-165` |
| 隔离子 agent 存活期间（含 parked 后被恢复）一直沿用同一个隔离工作区；工作区的改动到生命周期释放时才捕获成补丁与分支，然后清理。omp 进程重启后，隔离运行不会从持久化记录恢复，只能重新派出 | `CA/task/isolation-runner.ts:363-431`；`CA/task/persisted-revive.ts:72-82` |
| 插件没有公开的 spawn 接口；`runStructuredSubagent` 需要内部的 `ToolSession`，拿不到 | 探针：`runStructuredSubagent` 预检失败，报错 `getSessionSpawns is not a function` |
| 插件经包路径 `@oh-my-pi/pi-coding-agent/irc/bus` 拿到进程级单例 `IrcBus.global()`；`send({from: MAIN_AGENT_ID, to, body})` 对 parked 的收件人先经 `AgentLifecycleManager.ensureLive` 恢复会话，再投递消息并开始一轮；不等待收件人的回合，回执 `outcome` 为 `revived`、`woken`、`injected` 或 `failed`（未知、aborted、无法恢复）。宿主自己的 cleanse agent 也这样从主会话唤醒子 agent | `CA/irc/bus.ts:27-35,56-186`；`CA/cleanse/agent.ts:203-210`；`PKG:61-64`；`CA/registry/agent-lifecycle.ts:334-418` |
| `task` 条目的 `name` 原样作为 agent id（请求名），不清洗也不截断；名字已被占用（包括输出目录里已有的旧运行）时加 `-2`、`-3` 后缀，旧条目不会被替换；实际 id 就是 `AgentRef.id`，也就是 `ctx.agent.id` | `CA/task/index.ts:768-772,1003-1010`；`CA/task/output-manager.ts:55-91,115-118` |
| `ctx.agent.name` 是 agent 定义名（例如 `task:mid`），不是请求名。核验调用者的方法是：用 `ctx.agent.id` 查 registry，并确认该条目的 `session.sessionManager` 就是调用者的 `ctx.sessionManager` | `CA/sdk.ts:2009-2011,3235-3242,3952-3968,4828-4840`；`CA/task/executor.ts:3998-4009`；`CA/registry/agent-registry.ts:70-78,146-164` |
| `task` 条目的 agent 类型声明了 `blocking: true`，或者宿主设置 `async.enabled` 为假时，子 agent 在父会话这一轮内同步运行，父会话要等它结束才能继续。`async.enabled` 默认为真 | `CA/task/index.ts:768-772,895-904,1167-1170`；`CA/tools/settings.ts:846-850` |
| 隔离派出（`isolated: true`）要求主会话的工作目录在仓库里：宿主用 `getRepoRoot(cwd)` 找仓库根，找不到就报 `Git repository not found for isolated task execution.`，这次派出失败 | `CA/task/worktree.ts:58-72`；`CA/task/isolation-runner.ts:145-149`。探针（真机 E2E，2026-09-30）：主会话在非仓库目录里按票据派出 owner，`task` 失败并报上述原文，主会话随后改用非隔离方式派出 |
| 子 agent `yield` 时的文字会作为原生消息自动送达父会话 | `CA/task/executor.ts`（异步 job 结果投递） |

## GitHub

| 性质 | 证据 |
|---|---|
| `gh pr merge --match-head-commit <sha>` 在 HEAD 不符时拒绝合并 | `gh pr merge --help` |
| PR 的 `mergeable` 由后台计算，可能返回 `UNKNOWN` | GitHub GraphQL `PullRequest.mergeable`（`MergeableState`） |
| 已关闭的 sub-issue 会计入 parent 的完成进度 | GitHub sub-issues 文档 |
| 所有 agent 共用同一个 `gh` 账号（RiriAgent），评论的作者字段无法区分席位 | `gh auth status`；账号路由规则 |
| base 不是默认分支的 PR，GitHub 不解析其中的 closing keyword：`closingIssuesReferences` 为空，issue 的 `closedByPullRequestsReferences` 也为空 | 探针（#3 交付）：沙盒 PR #8 以 `rt-sandbox/base` 为 base，正文含 `Closes #7`，两个字段都为空 |
| REST 的 issue 列表在新建 issue 之后会短暂漏掉它；GraphQL 的 `repository.issues` 连接与单个 issue 的读取是写后即读一致的 | 探针（#3 交付）：3 次新建中都观察到，REST 列表在 0.6–2.7 秒内漏掉新 issue，GraphQL 已经列出 |
| GraphQL 文档定义了却没用到的 fragment 会让整个查询失败 | 探针（真机 E2E，2026-09-30）：只展开 `...PR`、同时定义 `fragment ISSUE` 的查询返回 `Fragment ISSUE was defined, but not used`，`openPr` 因此连续失败 |
| 一次 GraphQL 查询的可能节点数上限为 500,000，按各层连接的 `first`/`last` 相乘计算，与实际数据量无关 | 探针（同上）：按创建时间列 100 个 issue、每个带 50 个完整 PR（含 100 个 check context）的查询报 `requests up to 1,020,100 possible nodes`；parent 带 100 个 sub-issue 的 facts 查询报 1,040,701。前者改为只读标题、正文与创建时间，后者把 closing 引用改读为链接，之后两个查询都通过 |
| GraphQL 的点数按各层连接可能需要的请求数计费：`first`/`last` 沿嵌套相乘后除以 100，与实际返回多少无关；认证用户每小时 5000 点 | 探针（真机 E2E，2026-09-30）：带 parent 的 facts 查询在 issue 的 closing 链接下再读 `closingIssuesReferences(first: 50)`，每次 54 点；每 30 秒一轮，不到一小时就报 `API rate limit already exceeded`。去掉链接下的嵌套连接后同一查询 2 点 |
