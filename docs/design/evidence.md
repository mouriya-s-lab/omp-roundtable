# 边界证据

本文记录已经观察的外部性质及其证明范围，不设立规则。HostPort、语法探针、纯协议与完整产品验收是不同路径；边界成功不能代替最终源码上的 native/GitHub 交付或一小时活跃负载。

## 实际 native HostPort

`bun tests/acceptance/host-contract.ts` 在实际 Tern arm64 executable `/Users/mouriya/Library/Application Support/Tern/omp/bin/omp` 上 exit 0，宿主报告 `omp/18.11.1`。证据为 `/tmp/rt-host-contract-JkN9Jc/evidence.jsonl` 的 115 条记录。

|实际观察|证据记录|
|---|---|
|Main 与真实 async isolated task:free child 的 registry session.sessionManager 等于各自 hook ctx.sessionManager；lifecycle 管理同一 registry|5–20、21–44|
|Main 与 child 的 defaultInactive 工具隐藏、激活、还原；新 ctx 不改变同一 manager 的绑定|9–10、17、33–39|
|真实 Git cwd、async.enabled、task isolation、async manager、effective nonblocking agent preflight|49–58|
|错误 request/run/parent/holder 的 wake 均 precondition 拒绝|59–66|
|真实 park/detach、child shutdown、同 agent 经 ensureLive 获得新 manager；新实际模型回合仍为授权模型/low|67–76、80–84|
|production HostPort.wake 返回 literal woken receipt 时 child terminal count 仍为 1，随后同 child 回答 HOST_CHILD_WOKEN 到 count 2|77–87|
|实际 idle plan 拒绝；manager release 后拒绝、真实 rebind；abort 与 absence 拒绝|89–101|
|Main shutdown 释放 binding、HostPort dispose、root 和专用 broker 均 exit 0；无 PTY、无凭据复制|110–115|

wake 返回用时约 22.79 ms；这是该次调用结果，不是性能保证或 exactly-once 证明。SeatRequest 是在真实 task acceptance/registry/context 之后建立、明确标成 TEST-owned 的 HostPort fixture，不是产品 spawned ACK。该次没有 controller、根产品插件、compact 或 GitHub 交付，最终集成 head 仍须完整重跑。

native 会对各席位重新执行 extension module graph；模块局部变量不能承担跨席位 runtime slot。探针使用 process Symbol slot 后才共享状态。Root 与 child 的实际模型请求均经 hook 核对，不从 task:free 名称推断模型。

## 实际工具语法边界

native root `z` 是 omptype facade，不是独立 Zod4 schema；把 own-Zod4 节点嵌入 host object 实际抛出 `e.k` 相关 TypeError。root 未导出 toJSONSchema/fromJSONSchema bridge。纯 host root union 能注册并暴露 anyOf，但指定 DeepSeek low 实际请求返回 HTTP 400、零工具调用；同 prompt/model 的 strict root object control 成功。没有把无错误正文的 HTTP 400 解读成 provider 的具体诊断文本。

独立验收命令 `python3 /tmp/rt-production-grammar-tA1RNg/launch.py` 实际导入生产 `buildPublicGrammar` 与 parseToolParameters，以 native root z 构造 strict `{input:PortInput}`，没有导入手写 grammar 副本。宿主 18.11.1 暴露 39,207-byte 完整 schema，五个 op、七个 reply、33 个 decision alternative 在八次实际 provider 请求中全部保留。指定 DeepSeek low 实际完成 tickets、gate verdict、deep acceptanceMethod/draft-transfer 和两项 question claim 四次 callback；每次 canonical 接受，native i 出现在模型参数而不在 callback 参数。root 与专用 broker 均 exit 0，证据在该目录的 evidence.jsonl、extension.jsonl 与 schema snapshots。

同一次生产 factory 验收的 100 项独立输入含 68 正向与 32 反向；host/canonical 接受结果零差异，68 项转换后的值均相同，零逸出异常。反向包含 flat/extra roots、nested extras、未知 tag、missing 字段、非法 SHA/ticket、unsafe integer 与 0/1/3 项/非 string 的 readings。checked tuple transform 不改变 wire 中 array/minItems=2/maxItems=2；实际 question callback 保持两项原顺序。

host `.int()` 本身不提供 own-Zod4 的 safe-integer 上限，必须显式 max(Number.MAX_SAFE_INTEGER)。host `.regex()` 实际运行时校验，但 pattern 未进入 wire schema。普通 closed union 的 pure facade probe 对非法 nested reply.head 返回准确 field path 与 must be removed，不需要把所有错误压成字符串。

此验收接受生产公开语法、native/canonical parity 与真实模型到 callback 的 transport；没有运行 controller/business authorization、文件存储或 GitHub 交付，也不是最终源码 commit 的完整产品验收。source hashes、模型 selector/reasoning 与进程终点保留在上述 artifact，最终集成 head 仍须重跑其完整路径。

## 匹配版本源码

以下 named exports 和调用性质已经按 v18.11.1 对照；版本只用于取证，不在实现中钉住。

|性质|源码|
|---|---|
|registry status/parent/session/createdAt 与同步 onChange|[agent-registry.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/registry/agent-registry.ts)|
|ensureLive 返回实际 session，park/manages|[agent-lifecycle.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/registry/agent-lifecycle.ts)|
|deliverIrcMessage 返回 injected/woken，不等 child 整个模型回合；idle plan 与 streaming 不同|[agent-session.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/agent-session.ts)、[irc-bridge.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/irc-bridge.ts)|
|native virtual named registry/task/tools 模块；不以 root wildcard 取得内部 bus|[virtual-module.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/scripts/legacy-pi-virtual-module.ts)、[compat.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts)|
|before_agent_start systemPrompt:string[]、setActiveTools Promise、sendMessage void；context custom message 与 yield 拦截|[extension types](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/extensibility/extensions/types.ts)|
|RPC ready 先于 extension 完整初始化；session_start、prompt admission 与 prompt_result 分开|[rpc-mode.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/modes/rpc/rpc-mode.ts)|
|effective agents 的多来源 discovery 与 blocking|[discovery.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/task/discovery.ts)、[types.ts](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/task/types.ts)|

`registry.onChange` 不处理 callback 返回的 Promise；异步错误需由插件处理。`pi.sendMessage` 的 void 返回不是提醒 durable receipt，headless --no-ui 的 notify 也不是操作员可见通知。typed settings registry 的 duplicate id registration 会抛错；实际读取来自 session.settings，不是一个假定存在的 ctx.settings/getConfig。

installed 18.11.1 `task/executor.ts` 在子任务结束后保留 session 并设为 idle，生命周期接管 idle TTL；其 4033 行明确 `task.agentIdleTtlMs <= 0` 禁止自动 parking。`task/settings.ts` 的默认 TTL 为 420,000 ms。因此 idle 不等于正在执行，也不能假设它最终一定进入 parked；这个源码性质不证明任何一次真实 delivery，实际调用仍须按 HostPort 的 plan/streaming/request precheck 取得 receipt。

## 模型与凭据

操作员允许所有圆桌 e2e 使用 task:free 同款，或 OpenCode Go DeepSeek v4.1 Flash:low。本轮选择 exact selector `opencode-go/deepseek-v4.1-flash`、thinking low，不继承 task:free 的其它 provider/fallback 链。`omp models ls deepseek --json --no-extensions` 已确认该 selector 和 low/high/max；其非零定价不改变操作员授权范围。

最小生成 `/tmp/rt-native-model-jV7ymU/evidence.jsonl`、真实 Main/child HostPort 和完整 schema/tuple 探针都记录了实际 provider/model/low。owner-controlled 专用 loopback broker 使用既有 secret store；token 只在 launcher 内存及 child env，HOME/agent/config 隔离，不复制或链接 owner DB/config/models，不改全局模型绑定。[broker 源码](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/cli/auth-broker-cli.ts) 和 [文档](https://github.com/can1357/oh-my-pi/blob/v18.11.1/docs/auth-broker-gateway.md) 对应此注入路径。

## GitHub 实际读数

CLI actor RiriAgent；产品 repo 与现有 sandbox `RiriAgent/rt-e2e-20260930-0931` 均 ADMIN、default main、未 archived。观察时 main 无 classic protection/effective required rules，不证明专用 required-check 正向约束。发布 workflow 在 main push 后推进版本；gh merge 成功也可能只进入 queue，必须另读 MERGED。

迁移后的 production GitHubPort 实际只读命令 `bun /tmp/rt-rewrite-wfPGFO/facade-github-smoke.ts` exit 0。证据 `/tmp/rt-rewrite-wfPGFO/facade-github-evidence.jsonl`：无 PR 的显式 main/不存在 base 查询返回准确 present/missing；十个真实 issue、十个显式 PR 的完整 source 请求返回所有身份、真实 timestamp/target/head，且没有执行 mutation。这只证明源头读取边界，不证明 controller 或完整交付。

实时 schema 提供 active repository/org Ref.rules、classic protection、required context+integrationId/app.databaseId。实际 [workflow run](https://github.com/oh-my-omp/omp-roundtable/actions/runs/38576098395) 为 workflowRun=38576098395、checkRun/job=115893483137、suite=104529942127、app=15368、attempt=1；只证明该实例关系，不能推广 job/checkRun 恒等。失败 workflow attempt 的 jobs API 还实读到 run_id/run_attempt/head_sha/check_run_url，production 会完整分页并核对；required Actions failure 的最终正向路径仍需专用 fixture。


source 观察到 actor 自己同 repo PR 的 maintainerCanModify=false，因此该字段单独不足以判 foreign；ADMIN 也不证明其它作者交接。non-default close、真实 rerun/create recovery、完整 mutation failure/unknown、最终 native 产品路径和 3,600 秒负载尚不能由这些只读/HostPort 证据宣称通过。[GitHub secondary throttle 文档](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) 允许没有 Retry-After 且剩余额非零；未实际触发限流，不编造 reset 时间。
