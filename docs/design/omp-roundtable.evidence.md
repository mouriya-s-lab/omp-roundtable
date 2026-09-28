# omp-roundtable：域证据

[omp-roundtable.md](omp-roundtable.md) §1 的附件。下表记录各条域性质的证据。

- 宿主版本：omp 18.4.2，安装在 `~/.bun/install/global/node_modules/@oh-my-pi/`。
- 路径缩写：`CA` 指 `pi-coding-agent/src`，`PKG` 指 `pi-coding-agent/package.json`。
- 除非标明「探针」，下表的证据都来自源码。

## omp 宿主

| 性质 | 证据 |
|---|---|
| 子 agent（普通、隔离、孙级）都在同一个 OS 进程里运行；隔离只改变工作树，不另开进程 | `CA/task/executor.ts:3472-3475,3919-4026`；`CA/task/isolation-runner.ts:432-452` |
| 插件的工厂函数在每个会话绑定时各执行一次。根会话只导入一次插件模块，并把已准备好的工厂转交给非隔离子 agent，子 agent 只重新绑定、不重新求值模块，所以与父会话共享模块实例。隔离子 agent 清空这些预加载后重新导入，每次导入带新的 `?mtime=<tag>`，于是各得一份模块实例。席位按 spawn 票据都以 `isolated: true` 派出，因此模块顶层状态在席位之间不共享；进程内共享的状态放在 `globalThis` 的 `Symbol.for` 槽位里。经包路径导入的宿主单例（如 `AgentRegistry`）仍然共享 | `CA/extensibility/extensions/loader.ts:555-563`；`CA/sdk.ts:2522-2553`；`CA/task/isolation-runner.ts:436-441`（`preloadedExtensionPaths`、`preloadedPreparedExtensions` 置为 `undefined`）；`CA/extensibility/plugins/legacy-pi-compat.ts:2622-2630`（`import(\`${entrySpecifier}?mtime=${nextLegacyPiLoadTag()}\`)`）。探针（#4 端到端运行）：主会话已召集议程，隔离派出的 owner 席位的模块实例却报告「本进程当前没有进行中的议程」 |
| 只有通过包路径导入（例如 `@oh-my-pi/pi-coding-agent/registry/agent-registry`）才能拿到 CLI 运行时的单例；用绝对路径导入源码会得到另一份单例 | 探针：包路径导入时输出 `registry= Main`，绝对路径导入时输出 `registry= missing`；`PKG:56-64` |
| `ctx.agent` 提供 `kind`、`id`、`name`、`depth`、`parentId?`，工具的 `execute` 和 `pi.on` 的处理函数都能拿到 | `CA/extensibility/extensions/types.ts:431-452`；`CA/sdk.ts:3227-3244` |
| 插件注册的工具默认对子 agent 可见，除非会话设置了 `restrictToolNames`，或工具声明了 `hidden` / `defaultInactive` | `CA/sdk.ts:2542-2569` |
| `tool_call` 钩子在调用者自己的会话里执行，可以返回 `{block, reason}` 拦截调用；处理函数出错时按拦截处理 | `CA/extensibility/extensions/wrapper.ts:255-278`；`CA/extensibility/shared-events.ts:319-333` |
| `context` 钩子在每次主循环模型请求前执行，接收并返回 `{messages}`；在主会话和子会话中都会执行；追加的消息只用于本次请求，不写进会话历史 | 源码：`CA/extensibility/shared-events.ts`（`context` 事件）。探针：compact 之后抓到的下一次请求体里带着注入的标记 |
| `sendUserMessage` / `sendMessage` 只作用于该绑定所在的会话：会话存活且空闲时会启动一轮，正在运行时会排队；会话 parked 之后旧绑定失效，aborted 时不可投递 | `CA/extensibility/extensions/types.ts:1492-1516`；`CA/irc/bus.ts:97-184`；`CA/task/executor.ts:3210-3253` |
| parked 的席位被恢复后会重新执行插件绑定，所以要在新会话的 `session_start` 里刷新绑定 | `CA/irc/bus.ts:97-184`（`ensureLive`） |
| 隔离子 agent 第一次的补丁合入之后，后续轮次在保留的工作树里进行，不会再次自动合入 | `CA/task/isolation-runner.ts`；`CA/task/executor.ts` |
| 插件没有公开的 spawn 接口；`runStructuredSubagent` 需要内部的 `ToolSession`，拿不到 | 探针：`runStructuredSubagent` 预检失败，报错 `getSessionSpawns is not a function` |
| `task` 条目的 `name` 是请求名：同步派出时只保留 `[A-Za-z0-9_-]` 并截断到 48 个字符；同一个分配器里重复的名字会被加上 `-2`、`-3` 后缀，旧条目不会被替换；实际 id 就是 `AgentRef.id`，也就是 `ctx.agent.id` | `CA/task/index.ts:850-870`；`CA/task/structured-subagent.ts:215-218,433-441` |
| `ctx.agent.name` 是 agent 定义名（例如 `task:mid`），不是请求名。核验调用者的方法是：用 `ctx.agent.id` 查 registry，并确认该条目的 `session.sessionManager` 就是调用者的 `ctx.sessionManager` | 同上；`CA/registry/agent-registry.ts` |
| `task` 条目的 agent 类型声明了 `blocking: true`，或者宿主设置 `async.enabled` 为假时，子 agent 在父会话这一轮内同步运行，父会话要等它结束才能继续。`async.enabled` 默认为真 | `CA/task/index.ts:749-767,895-896,1302-1306`；`CA/tools/settings.ts:846-850` |
| 子 agent `yield` 时的文字会作为原生消息自动送达父会话 | `CA/task/executor.ts`（异步 job 结果投递） |

## GitHub

| 性质 | 证据 |
|---|---|
| 渲染 Markdown 时隐藏 HTML 注释（`<!-- ... -->`） | GitHub Flavored Markdown 规范中关于 HTML 块的部分 |
| `gh pr merge --match-head-commit <sha>` 在 HEAD 不符时拒绝合并 | `gh pr merge --help` |
| PR 的 `mergeable` 由后台计算，可能返回 `UNKNOWN` | GitHub GraphQL `PullRequest.mergeable`（`MergeableState`） |
| 已关闭的 sub-issue 会计入 parent 的完成进度 | GitHub sub-issues 文档 |
| 所有 agent 共用同一个 `gh` 账号（RiriAgent），评论的作者字段无法区分席位 | `gh auth status`；账号路由规则 |
| base 不是默认分支的 PR，GitHub 不解析其中的 closing keyword：`closingIssuesReferences` 为空，issue 的 `closedByPullRequestsReferences` 也为空 | 探针（#3 交付）：沙盒 PR #8 以 `rt-sandbox/base` 为 base，正文含 `Closes #7`，两个字段都为空 |
| REST 的 issue 列表在新建 issue 之后会短暂漏掉它；GraphQL 的 `repository.issues` 连接与单个 issue 的读取是写后即读一致的 | 探针（#3 交付）：3 次新建中都观察到，REST 列表在 0.6–2.7 秒内漏掉新 issue，GraphQL 已经列出 |
