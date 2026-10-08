# 认证、模型与推理

本文件供修改登录、凭据保护、模型设置、推理请求或排查网络时查阅。安装与日常操作见 [README.md](./README.md)，模块边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)，验证方法与历史结果见 [VALIDATION.md](./VALIDATION.md)。具体默认值以链接的代码为准；某次账号的可用模型不代表其他账号或后续目录。

## 官方登录与权限

[server/auth.ts](./server/auth.ts) 独立封装官方 `@siwc/local`；`@siwc/react` 提供登录按钮。DevKit 负责 PKCE/OIDC、loopback callback、稳定 host ID、动态 client 注册、账号会话、刷新和退出。ChatGPT 方式不重写 OAuth 流程；用户也可明确选择 OpenAI、DeepSeek 或 GLM 标准 API。没有非官方推理端点、生产 Demo Provider、模拟登录或自动切换回退。

官方登录由用户本人完成。**Connected** 表示身份连接有效；**Using ChatGPT plan** 表示 ChatGPT Plan Usage 已授权，不能只依据 Connected 启用推理。未授权时用户可点击“启用 ChatGPT Plan Usage”；初次启用展示使用说明，**Manage usage** 打开 [ChatGPT Usage 设置](https://chatgpt.com/settings/usage)。

账号资格、工作区策略、地区、模型支持及额度由官方服务决定。登录不授予应用读取 ChatGPT 对话或记忆的权限；分析会发送当前项目的产品需求与澄清上下文。授权失败时保留本地设想，连接恢复后继续。

重启复用稳定 host ID 和已验证注册；有效连接由运行时恢复并按需刷新。连接可分别添加和切换。**Sign out** 清除所选连接的本地凭据并尝试远程撤销；撤销失败时提示用户到官方设置断开，不能谎报远程撤销成功，也不能删除整个认证目录代替退出。

## 凭据与本地请求保护

Windows 适配器使用 DPAPI `CurrentUser` 加密认证运行时，通过 Node/PowerShell 匿名管道传递加密材料，不创建临时明文文件。加密凭据与 Windows 用户绑定，不能直接复制到另一个用户或设备解密；其他平台需要 OS secret-store 适配器，不允许明文回退。

认证文件位置见 [README.md](./README.md)。保持 host ID 和注册映射，不以清空用户认证目录进行测试，不擅自退出已有连接。

Token、API Key、授权码、PKCE verifier 和未脱敏认证状态不能进入前端响应、localStorage、日志、命令参数、临时明文文件或 Git。Key 仅在填写与提交期间存在于浏览器内存，提交即清空输入框。后端只返回配置/验证状态，不返回 Key。

[server/ai-connections.ts](./server/ai-connections.ts) 将三家 API Key、当前连接与模型偏好加密保存至独立 `model-api-keys.json`；原 ChatGPT 存储不改格式。API 读写以凭据文件为独立锁对象，使用 `realpath:false` 支持首次保存；ChatGPT 保留原目录锁。两者不能只更换锁文件名却使用同一锁对象，否则 `proper-lockfile` 的进程内登记会互相覆盖。API 另有进程内串行队列；加密成功后写临时密文并原子替换，失败保留原文件。更换 Key 清除旧测试状态；移除只删除该厂商 Key，其他 Key 与 ChatGPT 账号保留。没有明文回退。

Windows 对密文原子替换偶尔返回 `EPERM` / `EACCES` / `EBUSY` 时，只对同一次文件替换最多额外尝试四次，等待总计不超过 250 毫秒，每次仍检查锁有效性；持续失败保留原文件。这个本机文件处理不重复加密、不重试网络请求或模型调用。

[server/main.ts](./server/main.ts) 只监听 `127.0.0.1`；[server/app.ts](./server/app.ts) 核验本地 Host、Origin 与 HttpOnly 会话，保留响应和静态资源的保护。不要改为 `0.0.0.0` 或将私有数据目录暴露为静态资源。

## 模型目录与用户设置

统一界面在 [src/ai-panel.tsx](./src/ai-panel.tsx)，ChatGPT 登录区在 [src/chatgpt-panel.tsx](./src/chatgpt-panel.tsx)。连接、模型与参数类型在 [shared/inference.ts](./shared/inference.ts)，能力映射与校验在 [server/model-capabilities.ts](./server/model-capabilities.ts)。

ChatGPT 从 DevKit 目录发现模型；兼容旧请求时仍优先可用的 `gpt-6.1-sol`，否则取首个适用文本模型。界面将旧自动设置解析并保存为实际模型 ID；已有手动选择保留。API 必须主动选模型，没有自动选择。OpenAI、DeepSeek 读取官方 `/models`；OpenAI 筛选适用 Responses 与结构化输出的文本模型族，DeepSeek 使用目录中的思考能力元数据。GLM 清单维护在代码中，首批为 `glm-5.2` 与 `glm-5.3`。目录不是模型权限或请求成功的保证。

| 设置 | 当前行为 |
| --- | --- |
| 模型 | 显示实际 ID；读取期间显示加载，失效选择报错，不能作为可用模型开始审查 |
| 思考 | 只展示和发送模型支持的参数；ChatGPT 当前保留 DevKit 的 low / medium / high；OpenAI 按模型族维护能力；DeepSeek 支持目录提供的强度及关闭思考；GLM 5.2 可开关，不发送强度，5.3 不能关闭且提供 low / high / max |
| 默认参数 | 选模型时使用能力记录的默认值；无思考能力的模型不发送 reasoning；全局 Schema 不自动补 high |
| 等待上限 | 审查 high / xhigh / max 或未指定强度为十分钟，其余三分钟；连接测试三分钟，均可主动取消 |
| 保存范围 | 后端独立加密配置文件；ChatGPT 按账号，API 按厂商保存偏好；不进入产品字段、Review 或 Baseline |

后端拒绝非法模型/参数。账户轮询等待上次完成，同时到来的账户状态读取共用进行中的请求。连接配置响应中的 ChatGPT 状态使用最近完成的轮询快照；API 配置操作不等待新的 ChatGPT 读取，界面官方登录状态仍由 `/api/auth` 获取。账号变更后的旧状态响应不能覆盖新快照。

模型目录在后端内存缓存 60 秒，按厂商与 ChatGPT 账号隔离，合并同时到来的目录请求；偏好校验与紧接的目录加载复用结果。主动刷新绕过缓存；成功更换/移除 Key、账号或授权状态变化使对应目录失效，失败目录不缓存、不自动重试。缓存只包含模型能力信息，不包含 Key。实际推理仍由 Provider 核验当前模型和参数，不以缓存目录证明账号权限或请求成功。

配置修改与推理互斥；审查/测试期间拒绝更换 Key、切换账号和修改连接/模型。刷新后的脱敏配置读取等待进行中的配置修改完成，避免偏好已写入但配置还未结束时提前显示可用；不等待独立账号轮询，不自动排队发起推理。请求使用已解析的连接、模型、参数与凭据，取消、旧修订和迟到结果不能写草稿。失败不自动换连接或重试。

内部接口受原有本地 Host、Origin 和 HttpOnly 会话保护：

| 接口 | 职责 |
| --- | --- |
| `GET /api/ai/connections` | 脱敏配置、测试状态、当前连接与偏好 |
| `PUT / DELETE /api/ai/connections/:id/key` | 加密保存/更换、移除该厂商 Key；保存不推理 |
| `PUT /api/ai/preferences` | 核验目录、能力后保存当前连接和模型参数 |
| `GET /api/models?connectionId=...` | 对应连接的模型目录；省略仍为 ChatGPT；`refresh=1` 主动刷新 |
| `POST /api/ai/connections/:id/test` | 用户主动测试一次小型结构化请求，记录对应模型成功或失败 |
| `POST /api/ai/test/cancel` | 取消连接测试 |

产品推理请求的 `inference.connectionId` 省略时仍走 ChatGPT，不能借当前 API 偏好改变旧请求语义。

## 结构化请求与结果应用

[server/ai-provider.ts](./server/ai-provider.ts) 路由四种连接；[server/provider.ts](./server/provider.ts) 的 TaskProvider 共用四个任务的指令、输入组织、JSON 解析与 Zod 校验。ChatGPTTransport 和 [server/api-transport.ts](./server/api-transport.ts) 只处理认证、协议、能力与参数。实际 Runtime Prompt 是 [server/provider.ts](./server/provider.ts) 的 `conceptInstructions`、`additionInstructions`、`integrationInstructions` 和 `reviewInstructions`；修改 Markdown 原则不会自动改变这些指令。

| 请求 | 实际发送的产品资料 | 输出职责 |
| --- | --- | --- |
| `developConcept` | `intake` 原文/整理、完整 `conversation`、完整 `questions` 台账 | 整体设定、初始功能、必要问题与逐题关闭记录 |
| `analyze` | 完整 `draft`、`conversation`、`questions` 台账和固定任务说明 | 全部 P0 四 Gate、问题、独立 Proposal、关闭记录；可编辑内容返回完整字段、最小充分 Verification 与量化来源，新增阶段受保护内容显式引用原文 |
| `assessAddition` | 已提交当前 `baseline` 与保存的新增 `request` | 多项能力的归属清单与关联理由，不直接建立成员 |
| `reviewIntegration` | 当前基线、完整新增清单、成员、草稿、对话与台账 | 新旧/新增之间/同 P0 内的兼容结论与具体待接受方案，不生成四 Gate 和验收 |

新增阶段先独立调用 reviewIntegration，沿用所选连接、参数、超时和取消。用户接受的方案包含精确字段变更，由 Store 事务应用并使受影响验收失效；无冲突且无需修改旧规则时直接进入完整 MVP。analyze 共用首次与后续版本的 keyed items 结果契约，问题逐项列 affectedFields，用户确认才开放其中字段，全部 P0 重新输出四 Gate，受保护字段引用原文或由 Schema 固定。没有强制的 integrationDecision，也不自动建立衔接占位题；更新验收依旧核验量化来源。

Review 不另外发送完整 Intake；已有设想可能经确认定义和对话进入上下文，候选 Reset 清理旧对话后不会继续发送这些历史消息。模型输入包含工作资料，正式基线及复制不包含它们；Token 不在上述产品资料内。

Prompt 要求忠实归纳 Purpose、不把建议写成事实、普通选项给完整业务方案，并采用个人 MVP 的最小充分验证。没有用户要求时不主动引入生产指标或进阶验证；量化要求须引用用户原文，未知值为 null。继续问题用 `questionId`，关闭通过 `resolvedQuestions` 给原因和后续用户引用，省略不代表解决。

整理与审查请求仍发送完整问题历史，但结果契约只允许引用当前阶段未解决问题的 ID；已解决和其他阶段问题只作为历史决定参考，不能重新关闭或继续引用。没有有效问题时 `resolvedQuestions` 必须为空，新问题 ID 必须为 null。关闭与继续提问不能重叠；后端继续核验合法引用、证据和事务，分别提示失效引用与同题关闭/提问的错误。

新增审查减少的是旧规则与验收的重复生成量，不减少完整输入、四 Gate 或冲突审查，也不自动重试、降思考强度或换模型。GPT-6.1 Sol 的 high 可能需要较长时间；用户可主动选择 medium 比较速度和审查质量。[OpenAI 延迟指南](https://developers.openai.com/api/docs/guides/latency-optimization) 建议减少输出生成量，[部署指南](https://developers.openai.com/api/docs/guides/deployment-checklist) 说明较低思考强度通常减少延迟。这些说明不代表本应用实际提速已测量，真实模型表现仍需在明确调用范围内验证。

| 连接 | 固定官方协议与输出保证 |
| --- | --- |
| ChatGPT | 原 DevKit 与 Plan Usage；公开 Responses，`store:false`、`stream:true`、严格 JSON Schema |
| OpenAI API | `https://api.openai.com/v1/responses`；严格 JSON Schema，`store:false`、流式完成事件 |
| DeepSeek API | `https://api.deepseek.com/responses`；官方 JSON Schema 输出，不发送未文档化的 strict 参数；`store:false`、流式完成事件 |
| 智谱 GLM API | 国内 `https://open.bigmodel.cn/api/paas/v4/chat/completions`；JSON object 模式，系统消息包含完整 Schema；不宣称服务端严格 Schema 保证 |

Responses 必须收到成功完成事件，GLM 必须正常 stop 并结束流；拒绝、截断、中断和失败均不应用。所有连接完整解析 JSON，拒绝重复对象键（包括转义后相同的键），并执行同一严格 Zod 校验，不截取自由文本、不修复或补齐字段。显式 `preserve` 是受限的原文引用协议，不能携带替代文本；缺少此动作、固定 P0 键、四 Gate 或更新必填内容仍拒绝。Store 再核验修订、P0、选项、问题引用、关闭证据和量化来源，事务成功后才应用。仅结构正确不保证模型语义正确。

[server/evidence.ts](./server/evidence.ts) 与 [server/questions.ts](./server/questions.ts) 可以证明引用来自本项目用户、原文和先后关系合法，也拒绝常见无来源指标；不能证明引用含义足以关闭问题或指标语义完全一致。四 Gate 通常由同一次模型输出产生，没有第二个模型自动审查；Ready 不是形式化正确性证明。详细边界见 [PRODUCT_IMPLEMENTATION_GUIDE.md](./PRODUCT_IMPLEMENTATION_GUIDE.md)。

[shared/domain.ts](./shared/domain.ts) 使用普通 Zod union 生成嵌套 `anyOf`。历史真实请求曾拒绝 `oneOf`，记录见 [VALIDATION.md](./VALIDATION.md)。改变 Schema 或协议时核对官方支持范围并做相应验证，不降级为自由文本解析。旧修订、取消、超时和迟到结果的应用保护见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

网络错误、授权拒绝、额度限制、模型拒绝、无效输出、超时或取消均保留已有草稿，显示脱敏且可重试的中文错误；不能清空已保存决定或误标 Ready。

## 网络排查

启动与真实验证脚本使用 Node `--use-env-proxy`；命令定义见 [package.json](./package.json)。已配置的受信任 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 会由 Node 使用，没有代理配置时直接连接。

排查时先检查已有代理配置、官方 discovery/JWKS 与推理端点的连通性，再区分连接权限、模型目录和推理错误。不要修改用户系统代理、泄露含凭据的代理地址，或用非官方端点绕过授权。用户明确选择的 API 连接使用对应 Key，不作为 ChatGPT 授权失败的自动回退。不要把网络故障解释为用户产品逻辑不完整。

## DevKit 来源与验证入口

固定上游来源、许可证和本地改动维护在 [vendor/README.md](./vendor/README.md)。修改 vendored 代码时保留许可证和来源，并记录实际协议或传输改动。

使用隔离测试检查 DPAPI、PKCE、loopback 和错误恢复；真实官方登录需要用户本人操作，真实模型验证会消耗所选 ChatGPT Plan Usage 或厂商 API 额度。Key 应由用户在应用内填写，真实调用范围另行明确；隔离测试不能证明真实接入成功。具体命令、隔离方式和何时需要真实请求见 [VALIDATION.md](./VALIDATION.md)，文档或普通界面修改无需默认运行真实推理。

官方资料（调整接口时重新核对）：

- [本地个人项目接入](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Plan Usage 请求限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)

API 官方资料（2026-10-08 核对；维护能力时重新核对）：

- [OpenAI Responses 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [OpenAI 模型目录](https://developers.openai.com/api/reference/resources/models/methods/list)、[GPT-5 Pro 强度限制](https://developers.openai.com/api/docs/models/gpt-5-pro)、[o3-mini 结构化输出](https://developers.openai.com/api/docs/models/o3-mini)
- [DeepSeek Responses](https://api-docs.deepseek.com/api/create-response/)、[模型目录](https://api-docs.deepseek.com/api/list-models/)
- [GLM JSON 模式](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output.md)、[GLM 5.2](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2.md)、[GLM 5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)

模型解析/结构错误记录脱敏阶段、类别和字段路径到 inference_failures。未知属性名替换为 *，不保存响应值、正文或凭据；业务拒绝只保存阶段与类别。无自动重试或 Schema 放宽。
