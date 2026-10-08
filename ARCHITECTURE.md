# 架构与数据流

本文件供修改模块边界、数据契约、存储、状态或主流程时查阅。长期产品约束见 [AGENTS.md](./AGENTS.md)，运行和数据位置见 [README.md](./README.md)，认证与推理细节见 [AUTH_AND_MODELS.md](./AUTH_AND_MODELS.md)。实现变化时更新对应章节，不将这里的实现说明复制成每个任务都要读取的指令。

## 技术与职责

应用采用 TypeScript、React/Vite、Fastify、Node 内置 SQLite 和 Zod。一个本地服务提供 UI 与 API，不需要额外数据库服务。具体依赖版本、Node 要求、包管理器和脚本以 [package.json](./package.json) 与 [pnpm-lock.yaml](./pnpm-lock.yaml) 为准。

| 路径 | 职责 |
| --- | --- |
| [shared/domain.ts](./shared/domain.ts) | 产品类型、严格 Schema、Verification 必填要求与 Ready 判定 |
| [shared/inference.ts](./shared/inference.ts) | 模型目录和推理设置的共享类型与校验 |
| [server/store.ts](./server/store.ts) | SQLite 分层、事务、修订、Proposal 接受、预览和幂等只读提交 |
| [server/questions.ts](./server/questions.ts) | 持久问题台账、稳定引用、答复状态和带用户证据的关闭 |
| [server/evidence.ts](./server/evidence.ts) | 用户引用有效性、量化来源及常见无来源指标检查 |
| [server/app.ts](./server/app.ts) | Fastify 路由、本地会话与请求保护、分析任务的超时、取消与结果应用 |
| [server/auth.ts](./server/auth.ts) | 官方认证封装、脱敏连接状态与 OS 凭据保护 |
| [server/provider.ts](./server/provider.ts) | 四个任务共用的指令、输入和结果校验，以及原 ChatGPT 传输 |
| [server/review-contract.ts](./server/review-contract.ts) | 按当前阶段有效问题生成 Schema；统一 MVP 的固定 P0 键、原文保留与关系方案契约 |
| [server/addition-review.ts](./server/addition-review.ts) | 逐字段权限与显式原文保留条件 |
| [server/model-json.ts](./server/model-json.ts) | 完整 JSON 解析及重复键拒绝，避免后值覆盖前值 |
| [server/ai-provider.ts](./server/ai-provider.ts)、[server/api-transport.ts](./server/api-transport.ts) | 四种连接路由、官方 API 认证/协议、流式完成保护 |
| [server/ai-connections.ts](./server/ai-connections.ts) | 独立 DPAPI 密文配置、原子替换、脱敏状态与偏好 |
| [server/model-capabilities.ts](./server/model-capabilities.ts) | 模型能力映射、GLM 清单和参数核验 |
| [server/main.ts](./server/main.ts) | 数据目录、监听地址、启动和进程退出 |
| [src/main.tsx](./src/main.tsx) | 中文主流程、背景编辑、连接和模型设置、最终确认与只读结果 |
| [src/ai-panel.tsx](./src/ai-panel.tsx)、[src/chatgpt-panel.tsx](./src/chatgpt-panel.tsx) | 统一 AI 连接、模型能力控件、Key 管理和原官方登录 |
| [src/workspace.tsx](./src/workspace.tsx) | 设想整理、统一决策卡、答案汇总、完整定义和验收详情 |
| [src/navigation.ts](./src/navigation.ts) | 用户导航恢复与当前修订下的功能状态 |
| [src/addition.tsx](./src/addition.tsx) | 新功能归属确认与当前基线/新预览的逐字段变化 |
| [src/baseline-text.ts](./src/baseline-text.ts)、[src/baseline-copy.tsx](./src/baseline-copy.tsx) | 从已提交基线生成完整 Markdown、剪贴板写入与手动复制回退 |
| [src/api.ts](./src/api.ts)、[src/styles.css](./src/styles.css) | API 访问与响应式样式 |
| [tests/](./tests/) | 应用自身的单元、集成、浏览器测试和测试专用 Provider |
| [scripts/](./scripts/) | 官方连接、模型界面与隔离真实流程验收 |
| [vendor/](./vendor/) | 固定来源的官方 DevKit 源码与许可证，改动记录见 [vendor/README.md](./vendor/README.md) |

共享 Schema 是前后端数据契约；字段变更需要一起检查存储、Provider、UI 和测试。认证、推理与产品存储保持独立，避免无关重构或额外数据库服务。界面和用户错误提示使用清楚的中文。

## 用户流程与内部阶段

一级导航是产品设想、MVP 梳理、最终确认；提交后只显示产品基线。候选整理、Review 和 Verification 在同一个工作区内呈现，内部继续分别保存。

| 内部阶段 | 保存内容与入口限制 |
| --- | --- |
| `concept` | 保存原始 `conceptInput`、AI 整理定义、建议功能、问题与答复；尚无正式 Candidate Draft，禁止预览和提交 |
| `candidate` | 用户确认设定与初始功能后建立 P0 稳定 `id`、`source`；保存结构化草稿、全局审查和独立 Proposal |
| `committed` | 只读当前基线及历史快照；普通编辑和重置仍拒绝，可明确发起新增草稿 |
| `addition` | 保存多项归属清单；确认后原子建立成员并进入 `integration` |
| `integration` | 独立新旧关系审查、用户接受精确方案；无未解决关系问题后进入完整 `candidate`，仍需新 Review |

首页只必填 Product Concept / Experience Premise，名称可选。设想整理提取产品是什么、使用场景、核心设定和初始功能；只在整体理解不足时提出问题。原始输入属于工作资料，确认后的 `productConcept` 进入 Draft 和新提交基线。

MVP 梳理默认展示自然语言草案、简短验收和“待整理／需要决定／存在冲突／已明确”。完整字段、Verification 详情和 Gate 依据折叠，手动编辑由用户主动开启。状态依据当前修订、字段、问题和独立 Gate 计算，不能复用旧审查或忽略未保存编辑。

## 数据分层

SQLite 表的创建与兼容入口在 [server/store.ts](./server/store.ts)。产品数据位置和备份注意事项见 [README.md](./README.md)。

| 表 | 内容 |
| --- | --- |
| `projects` | 独立项目身份、名称与创建时间 |
| `intakes` | 设想原文、整理结果、设想问题与修订号 |
| `drafts` | Candidate Draft 与修订号 |
| `conversations` | 澄清答复和自然语言调整等工作上下文 |
| `reviews` | 对应修订号的四 Gate、问题与依据 |
| `proposals` | 独立冲突建议、关联 P0、修订号和接受时间；未接受建议可以存于此表 |
| `inference_failures` | 脱敏的失败任务阶段、校验类别与字段路径，无响应正文或值 |
| `question_ledger` | 设想、新旧关系与候选的全部必要问题、稳定 ID、状态、创建依据、最新答复和关闭依据；Ready 使用此台账 |
| `decision_holds` | 保留旧未决定记录的兼容表；新未决定答复也写入/清理此表，当前问题恢复及 Ready 以台账为准 |
| `verification_sources` | 当前 P0 量化要求的索引、用户引用与审查修订；属于工作资料 |
| `app_migrations` | 已执行的增量迁移标记，避免重复导入旧问题 |
| `baselines` | 原有 v1 正式 payload，升级不改写；更新、删除由 SQLite 只读触发器拒绝 |
| `baseline_versions` | v2 及以后只读快照，项目/版本为主键，项目/提交修订唯一；最新版本是当前基线 |
| `feature_additions` | 每项目至多一个新增草稿的设想、归属清单、成员映射、关系结果、基础版本、逐字段权限与放弃时恢复资料 |

产品背景包含 `productDescription`、`coreUserGoal`、`productConcept`。P0 包含名称、`description`、`purpose`、`applicableState`、`coreRule`、`confirmedException` 和 Verification；候选另保留 `id` 与 `source`。V2 的 `source` 是用户确认时的功能描述，不是 `conceptInput` 的逐字引用。正式基线保留稳定 `id` 和确认的量化要求，排除 source、临时对话、选项、问题台账、来源/关闭依据、审查状态和未接受建议。

## 决策、Proposal 与修订

决策卡无预选。`answerMode=choices` 提供完整 A/B/C 方案与影响说明，加前端 D 自定义；只有两种合理方案时 C 为“暂不确定”。`custom_only` 只返回 C 暂不确定，前端加 D；缺少合理方案或用户要求指标但缺必要数值时使用此模式。后端拒绝确定选项中的常见未完成承诺，但不能判断所有方案是否充分。

模型单次设想问题/候选问题、关闭记录各最多 100 条；当前未解决问题也最多 100 条，超出时拒绝整次更新并保留原数据。候选最多 50 个，单项量化要求最多 30 条；这些是结构容量保护，不是两题/三题业务截断或完成轮数承诺。已解决台账历史不会因此裁剪。

所有有效问题按关联功能分组，跨功能问题单独成组，每题只展示一次。未提交选择按项目和修订号暂存于浏览器；修订变化后清除。旧 Review 没有选项时保留自定义答复入口，可重新审查生成选项。

`POST /api/projects/:id/decisions` 接收 `revision`、`answers`、可选 `proposalAcceptances: [{ issueId, proposalId }]` 和接受确认文案。后端从当前问题读取实际选项，核验问题、选项、Proposal 关联、修订和重复项；客户端不提交实际解决规则。包含接受规则时文案必须是“确认所选决定并接受解决规则”。

同一事务保存普通答复与所有明确接受的 Proposal，修订号只递增一次；任一项无效整批回滚。MVP 冲突规则附加到确认例外；关系方案只应用明确接受的精确字段 changes，同一字段相反要求整批拒绝；之后由统一 Review 检查一致性。程序没有自然语言规则求解器。自定义冲突答复先保存为用户决定，AI 整理出的 Proposal 仍需主动接受。保存后先继续当前阶段；关系阶段完成后接续一次完整 MVP 审查；失败时保留已保存决定，允许重试。旧答复和接受接口继续兼容。

保存产品字段、答复、调整或例外使旧 Review、Proposal、预览和确认失效。模型结果应用时核验发起修订，整理成功后递增修订并保存对应新修订的 Review。取消、超时和迟到结果的保护在服务端执行，不能依靠前端忽略响应。

## 问题台账与用户资料

`QuestionLedger` 独立保存稳定 ID、阶段、关联 P0/Gate、创建依据、创建修订、`openedAfter` 用户消息边界、最新答复消息和关闭依据。状态是 `pending_answer`（待答）、`pending_review`（答复待审查）、`undecided`（未决定）、`resolved`（已解决）。删除 Review 不删除台账，手动保存记录实际 before/after 变更，不清空其他未决定状态。

两类模型输入包括完整台账；继续提问用 `questionId` 引用原题，新题为 null。输出 `resolvedQuestions` 逐题给原因和用户引用；省略旧题不关闭。后端核验问题关联、用户角色、原文、时间顺序，引用须晚于问题边界且不能早于该题最新答复；内容相同的重新提交也只能引用最新消息。Provider 另收到每题 resolutionConstraints（最新答复及允许引用的用户消息 ID），完整对话继续提供上下文；后端仍核验原文及 changes.after。暂不确定和只有“帮我填”“你来决定”等委托意思的消息不能作关闭依据。失败诊断仅存阶段、分类、错误码及已知问题/消息 ID，不存正文、原始模型响应或凭据；错误明确指出问题及本轮未应用。手动变更仅允许引用 `changes.after`。未接受 Proposal 不能关闭冲突；旧修订建议不再接受，题目保留，等待新方案。

Provider 的请求 Schema 将可操作问题 ID 限定为当前阶段且未解决的台账记录；没有有效记录时关闭数组长度必须为零，新问题引用只能为 null。已解决记录仍完整输入供历史参考。同题关闭与继续提问由 Store 拒绝并回滚；失效关闭引用单独报错，避免误显示为同题矛盾。

Purpose 允许忠实归纳；AI 空输出保留已有 Purpose，用户主动清空有效。候选问题的 coveredGates 声明同一业务决定覆盖的审查项，保留 gate 作为主要类别；旧记录未声明时按 [gate] 读取，新模型契约必须提供。关联不可重复且包含主要 Gate，冲突仅 consistency、验证问题仅 verifiability。未解决问题阻塞全部关联 Gate，四 Gate 状态和依据仍分别保存；已有覆盖不会因重述被丢失。核心字段、Verification 或模型结论导致未通过 Gate 却无对应问题时，整轮拒绝并报 review_question_coverage_incomplete，不再拼出泛化补题；原草稿和台账保留。

引用有效性只证明出处和先后关系；内容是否回答充分、是否忠实归纳、是否出现新语义冲突，仍主要依赖模型和用户复核。

`POST /api/projects/:id/questions/merge` 接收 revision、questionIds、primaryQuestionId、answer 和 confirmation="确认合并重复问题并采用本次答复"。只允许 candidate 当前有效、相同 P0 集合、不含冲突/Proposal 接受的普通问题；推理中、过期、重复或未知 ID、无效答复及确认文案均拒绝。用户选择主问题并重新确认答案，无预选。事务保留主 ID、合并 Gate 和原问题的字段权限，保存新的确认/答复消息；次题归入 legacy，merge 保存原阶段、目标、确认消息和修订，旧问题原文与答复保持。修订仅递增一次，Review/预览失效，产品字段不改写；主题仍待审查或未决定。合并及历史依据不进入 Baseline。没有启动迁移或自动合并。

## Gate、Verification 与提交

四 Gate 的键为 `clarity`、`boundary`、`consistency`、`verifiability`，各自保存状态和依据，通常来自同一次模型输出，理由当前可空。冲突问题显示关联 P0、共同条件、双方规则和不兼容原因；按 Prompt，生效状态不同不应直接构成冲突，共同条件不明须澄清。程序核验结构并将未解决问题映射到 Gate，不独立证明冲突判断正确。

| Verification 类型 | 必填字段 |
| --- | --- |
| Agent | `agentProcess`、`expectedAgentResult` |
| Human | `agentSideReview`、`humanTest`、`observability`、`expectedHumanResult` |
| Hybrid | 同时满足 Agent 与 Human 的全部要求 |

无需额外观测工具时也明确写出可观测方式。Verification 是待实现产品的验收要求，不是本应用运行过的测试记录。

Prompt 默认要求个人 MVP 的最小充分验证：核心流程、已确认规则和影响结果的明显边界，给具体操作/输入、观察结果和判断标准。不主动增加防欺骗、数据集、统计报告或生产指标。实现负担是否适合个人产品仍是语义判断，没有成本 Gate。

可选 `quantitativeRequirements` 保存 `metric`、`target`、`sample`，未知值为 null。模型专用 Schema 要求返回此数组，持久化 Schema 兼容旧对象；普通 Zod union 保持 `anyOf`。`quantitativeSources` 按索引引用用户消息，另存工作表；后端核验指标名称和数字出处，拒绝常见无来源表达。没有用户指标不阻塞；已要求但缺必要门槛、常见空泛预期会阻止验收完成。比较符、分母、指标遗漏与所有自然语言含义没有穷尽证明。

Ready 要求 Review 带 `ledgerVersion=1` 且修订匹配、全部 P0 四 Gate 通过、P0 必填字段和适用 Verification 通过检查、Review 无问题且台账全部已解决；新增阶段须已完成独立关系审查，phase=review 且有保存的关系结论。它不重新验证全部背景字段，也不是语义正确性的证明。旧 Review 或尚未完成关系阶段的旧新增草稿须重新审查，功能卡片显示待整理；预览完整展示背景、规则、例外和验收，确认勾选不从旧导航或刷新恢复。

Commit 再次核验修订号、Ready 与指定确认语句，事务写入版本和实际提交时间。同一提交重试幂等；正式结果不可修改。后端不能证明用户实际读完预览。基线复制在前端从保存的 payload 生成，完整展示正式量化要求，不带来源元数据、不调用模型或额外读取文件；剪贴板失败时展示同一全文供手动复制。

## 恢复、重置与兼容

- 设想 Reset 保留当前保存的 `conceptInput`，清除整理、问题与答复；候选 Reset 保留背景、初始 P0 标识和来源，清空整理、验收、已接受例外和对话。两类 Reset 都清理台账、Hold 和指标来源；已提交项目拒绝 Reset。
- 新项目与旧项目隔离，切换和刷新按已保存状态恢复；旧澄清、候选、审查、验收导航映射到 MVP 梳理，旧预览重新核验生成。
- 数据库升级增量进行，不能删除用户数据库。旧 Baseline 不补写新字段；缺少设定时显示“旧版本未记录产品设定”。旧草稿可补充设定继续，旧选项缺失不阻止用户自定义答复。
- `app_migrations` 标记 0.2.2 增量导入：只迁入未提交项目仍在 Intake/Review/Hold 的问题，不恢复此前已丢失资料。旧 Review 缺 `ledgerVersion` 时必须重新审查再提交。

## 已提交项目的新增功能（0.3.0）

`startAddition` 只接受有当前基线且无进行中新增草稿的项目和当前修订。从正式当前快照构造候选，沿用已有 source，工作修订递增；`baselines` 与 `baseline_versions` 不变。`assessAddition` 使用独立严格 Schema，只接收已保存基线和新增原文；结果核验关联 P0 与修订后保存，仍不建立新功能。

`additionAnalysisSchema.items` 是多项清单，逐项验证目标和关联引用。`confirmAddition` 在单一事务建立所有新编号、记录 `members`（清单序号与 P0 对应）并进入 integration；已有目标保留成员与 source，不授权覆盖旧字段，也不预建占位题。

`POST /api/projects/:id/integration/analyze` 独立调用 `reviewIntegration`，输入当前基线、完整新增清单、草稿、决定和台账。结果包含全量 `checkedP0Ids`、结论、关系问题与关闭证据，不产生四 Gate 或验收。问题 stage=integration，方案包含独立 rule 与精确 changes（P0、字段、替换全文）。选择汇总时由后端读取保存方案，核验关联、修订和主动接受文案，事务应用；相同字段的不同替换要求使整批拒绝。自定义回答不直接改规则，需重新生成并接受 Proposal。规则改变清空对应 Verification，仅开放它的重建权限。

无关系问题（包括未被返回但尚未关闭的台账）后记录结论并进入 review，前端接续一次完整 MVP 请求；前一阶段失败不会自动重试。需要用户决定时留在 integration。没有冲突且不改旧规则不建泛化衔接题。工作结果保存在 feature_additions.integration，并标明修订；过期 Proposal 不能接受，界面显示需重新生成。

首次与新增后的完整审查共用同一 keyed items 契约与任务指令。所有 P0 必填且各自重新输出四 Gate；受保护成员 mode=preserve，由后端沿用草稿全文，允许更新的成员 mode=update，未授权字段在动态 Schema 固定为原文，Store 再逐字段核验。MVP 问题明确返回 affectedFields（关联 P0 与实际影响字段），用户汇总显示允许整理的内容；确认只开放这些字段，不按一个 Gate 整组开放目的、描述或规则。旧题缺此元数据不自动授权；模型需重新明确涉及字段。原样验收包括可选字段状态原样保留，不要求重建旧来源；新验收和改动检查来源。内容继承不等于继承通过结论，进入统一 MVP 后没有 Review 不能预览。

addition-stages-1 迁移只处理在进行中的旧新增工作资料：单项 assessment 包为单项清单、保留已确认编号和答复，回到 integration 并失效旧 Review/Proposal，修订递增一次；不自动拆分已确认组合能力。旧预建占位题转为 legacy 工作历史，不伪装成已解决业务决定；真实未决一致性题转为 integration，其他 MVP 题留在 candidate。历史快照不迁移或改写。

`inference_failures` 记录项目、修订、时间及脱敏的任务阶段、json/schema/business 校验类别和字段路径；不记录响应正文、值、凭据或未知属性名。解析/结构/业务失败保持原草稿，不能据通用报错猜测具体坏字段。

预览固定下一版本并展示与当前基线的差异；Commit 核验当前修订、Ready、基础版本与新增确认文案，原子插入新快照并结束新增会话。最新快照成为当前基线；历史行和 v1 原文不更新。重复同修订提交返回已保存版本，不再插入。`readBaseline` 只读指定版本，复制选中的保存内容。

“放弃本次新增”恢复开始时的已确认候选，清理本轮台账、消息和建议，递增工作修订并保留全部快照。旧/取消/迟到请求无法应用。新增阶段禁止普通 Reset，避免清空旧功能规则；刷新和实际服务重启可继续保存的归属/候选阶段。当前不做历史回滚、删除 P0 或并行新增草稿。

## 文档分工与参考

根目录保留 [README.md](./README.md) 作为人类使用入口、[AGENTS.md](./AGENTS.md) 作为长期约束，以及架构、认证模型、验证三份专题入口。当前规模不增加目录层级；专题扩展为多份文档时，可将细节移入 `docs/` 并保留入口。第三方来源和许可证跟随 `vendor/` 保存。

配置值由代码和 manifest 定义，专题文档解释行为；历史模型目录、测试数量和某次完成情况放在 [VALIDATION.md](./VALIDATION.md) 的日期记录中，不能当成长期要求。新规则进入 AGENTS.md 前，应确认它是否跨任务成立、容易被忽略且会损坏产品；普通操作和实现细节归对应专题。

以下是 2026-10-07 查阅的参考，不作为本仓库的外部指令：

- [OpenCode 根目录](https://github.com/anomalyco/opencode)将 [AGENTS.md](https://github.com/anomalyco/opencode/blob/dev/AGENTS.md) 与运行时专题 [CONTEXT.md](https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md) 分开维护；本项目借鉴按用途拆分，而不复制其具体开发规则。
- [uv](https://github.com/astral-sh/uv)将 [CONTRIBUTING.md](https://github.com/astral-sh/uv/blob/main/CONTRIBUTING.md) 和 [docs/reference](https://github.com/astral-sh/uv/blob/main/docs/reference/index.md) 分开组织，供不同任务查阅。
- [Codex 官方 AGENTS.md 说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)介绍根目录与子目录指导的加载；[官方关于精简上下文的建议](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)建议按任务引用资料，避免每次编辑都加载整套文档。

## 统一 AI 连接（0.4.0）

连接与模型配置独立于产品 SQLite。ChatGPT 的原凭据文件和多账号机制不变；三家 API Key 和偏好在数据目录的 `auth/model-api-keys.json` 内整体 DPAPI 加密。读写用进程串行队列和目录锁，临时文件仅含密文；加密/写入失败保留旧配置。前端只接收状态，Key 提交即清空，不进入浏览器持久存储、日志、产品输入和正式基线。

现有分析接口增加可选 `inference.connectionId`，省略仍为 ChatGPT。共用 TaskProvider 构造四个任务并严格校验结果；连接层只负责凭据、官方协议、目录与模型参数。OpenAI 使用 Responses strict JSON Schema，DeepSeek 使用 Responses JSON Schema，GLM 使用 Chat JSON 模式并发送完整结构说明；所有返回都经过同一 JSON/Zod 和 Store 业务检查，GLM 不具备服务端严格 Schema 保证。

`server/app.ts` 的配置修改屏障与运行任务表互斥：Key、偏好和 ChatGPT 账号修改必须没有运行中的审查/测试，配置保存期间也不能开始推理。请求固定已解析配置，API 请求只读取一次 Key；不自动重试或换厂商。既有超时、取消、旧修订和事务保护继续生效。

API 首次主动选模型，思考控件与后端验证按模型能力一致。ChatGPT 旧浏览器偏好仅在对应账号没有新配置时读取；旧自动设置保存为当前实际 ID，已有具体选择不变。模型目录未完成时显示加载，失效选择阻止推理。产品操作在目录读取期间等待，避免错过已连接状态下的自动审查。

账号轮询不叠加未完成请求，连接面板与账户同时读取状态时复用同一进行中的查询；完成后下一次仍重新读取，不缓存过期身份。配置保存与推理授权检查仍读取当前状态。

升级不迁移或重写 Baseline payload。独立连接接口与保护说明见 [AUTH_AND_MODELS.md](./AUTH_AND_MODELS.md)，机制和语义验收范围见 [VALIDATION.md](./VALIDATION.md)。
