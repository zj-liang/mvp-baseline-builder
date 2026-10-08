# Golden Cases：产品方法论验收

本文件是 MVP Baseline Builder 产品方法论案例的唯一维护入口，面向产品负责人和维护本仓库的 Coding Agent。实现机制及保证边界见 [PRODUCT_IMPLEMENTATION_GUIDE.md](./PRODUCT_IMPLEMENTATION_GUIDE.md)，程序验证命令与历史结果见 [VALIDATION.md](./VALIDATION.md)。

这些案例检查本应用是否保留用户决策权、正确处理产品规则、提出充分验收要求；不是要求本应用开发或测试用户描述的产品。本文件是验收标准与覆盖说明，不是自动执行的评测套件，也不代表所有案例已经全部通过。

初始案例及覆盖说明来自 2026-10-07 的实现检查。历史测试与内存探针不代表之后版本重新验收通过；代码、Prompt 或测试变化时，只更新受影响案例的覆盖与位置，保留已知缺口。下文引用的 2026-10-07 内存探针详见实现指南第 12 节，它们没有调用真实模型，也不是永久自动测试。

机制覆盖已按 0.2.2 更新；[VALIDATION.md](./VALIDATION.md) 的 2026-10-08 记录包含六次真实请求的人工语义核对，以下注明相关样例。这是有限历史证据，不是长期自动评测；本次文档校对没有重新执行这些请求。

0.3.0 新增 GC-14～GC-16 与对应隔离机制/浏览器检查。原 GC-04、GC-05、GC-08、GC-10 的 Proposal、台账、旧修订保护同样用于新增阶段；`tests/addition.test.ts` 和 `tests/addition-api.test.ts` 复核这些通道。新增阶段对未授权旧字段有额外保护，GC-09 的已授权功能含义判断仍非程序证明；GC-12 的旧正式验收可原样继承，新/变更验收仍须核验来源。本轮不新增真实模型语义证据。

0.4.0 增加四种 AI 连接与 GC-17；当前设想整理、归属判断、独立关系审查和完整 MVP 四个任务共用 TaskProvider 与 Store 约束。GC-04～GC-16 的机制回归继续执行，GLM JSON 模式严格本地校验但没有服务端 Schema 保证。ChatGPT 限定新增样例与三家 API 未真实验收的范围见 [VALIDATION.md](./VALIDATION.md)。

## 如何在任务完成前复核

1. 对照本次改动选择受影响的 GC 编号，说明关联；不要求每次重跑全部案例。纯文档修改检查案例迁移完整性、覆盖说明与引用，不据此宣称业务或内容语义通过。
2. 区分验证对象：程序机制检查状态、事务、引用等约束；内容语义检查是否编造、漏报、误判、替换意图或给出不充分验收。预制 Provider 或结构测试通过，只能证明其实际断言覆盖的机制。
3. 运行与改动风险匹配的已有检查，并逐项记录证据。需要核对实际模型内容时，应将输出与本案例的正确、错误行为比较，不能仅凭模型自己给出 pass、Ready 或成功 Commit 判定内容正确。
4. 真实模型请求遵循现有授权与验证范围，不默认消耗 Plan Usage。未运行、缺少内容评测手段或证据不足时，结论写“未验证”；发现违背案例的行为时写“发现问题”，保留具体差距，不以历史通过替代当前证据。
5. 任务交付中报告受影响案例的复核方式、证据、结论和未验证原因或已知问题。案例文件与报告不会改变应用 Ready、Gate 或 Commit 的判断，也不自动修复已有缺口。

## 统一报告格式

| 案例编号 | 复核方式 | 证据 | 结论 | 未验证原因或已知问题 |
| --- | --- | --- | --- | --- |
| GC-xx | 文档核对 / 程序机制 / 内容语义；注明具体方式 | 实际命令与断言、人工核对记录或日期明确的观察 | 已验证 / 发现问题 / 未验证 | 说明结论适用范围、未执行部分及仍存在的差距 |

“已验证”仅表示所列证据支持明确的检查范围。例如，程序机制测试通过不能让同一案例的内容语义也自动成为“已验证”。不在报告中复制认证凭据或无关用户资料。

## 案例

下面的“正确行为”是产品原则要求；“当前自动测试覆盖”区分程序测试与模型语义测试。测试标题用于定位现有用例，不代表本次任务重新运行过这些测试。

### GC-01：用户未提供时间，AI 不能自补 3 秒

- **输入**：“离席会扣心。”没有给离席判定时间、扣心数量。
- **正确行为**：规则保留阈值缺失；提出合并后的必要决定。可以在选项里建议“3 秒扣 1 心”，但用户确认前不能写成产品事实。
- **错误行为**：直接把 `coreRule` 写成“连续离席超过 3 秒扣 1 心”，然后标记 Ready。
- **当前自动测试覆盖**：没有持续自动调用真实模型的语义回归。`makeConceptP0Analysis` 的测试替身会先留空规则、再按答复填规则，只证明预制流程可以工作；不证明 Provider 对任意输出会拦截编造。2026-10-07 内存探针确认阈值编造未被后端阻断。2026-10-08 真实请求1/2经人工核对未自补未知阈值，是有限语义样例。
- **对应位置**：[tests/fixtures.ts](./tests/fixtures.ts) 的 `makeConceptP0Analysis`；[tests/concept.test.ts](./tests/concept.test.ts) 的 `stores confirmed concept in the baseline and excludes work records`；原则在 `reviewInstructions`，缺口在 `Store.applyAnalysis`。

### GC-02：共同状态和条件下的相反结果应检测直接冲突

- **输入**：P0-A：“正常监督中，离席超过 10 秒扣心。”P0-B：“正常监督中，离席不足 60 秒免罚。”共同情况是正常监督、离席超过 10 秒但不足 60 秒。
- **正确行为**：保留双方原规则，报告 Direct Consistency 冲突，显示共同条件、关联功能、扣心与不扣心的要求；提出待接受 Proposal，阻止 Ready。
- **错误行为**：全部 pass；或擅自假定免罚优先、缩窄扣心条件，把冲突悄悄消除。
- **当前自动测试覆盖**：部分。已有 Schema、Store 和浏览器测试覆盖收到正确冲突结果后如何保存、展示、阻止提交和接受。`tests/addition-conflict.test.ts` 增加实时判定与玩偶出现才判定的构造输出，覆盖独立新 P0 与归入同一 P0 的冲突；`tests/e2e/addition.spec.ts` 覆盖同 P0 选择、自定义、明确接受后再审查。新增阶段必须有单独衔接决定，不能只凭归属确认跳过，但后端仍没有自然语言冲突求解器。真实限定样例与未验证项见 VALIDATION；2026-10-07 首次草稿探针的语义漏报边界仍存在。
- **对应位置**：[tests/provider.test.ts](./tests/provider.test.ts) 的 `encodes conflict evidence and proposal restrictions in the output schema`；[tests/store.test.ts](./tests/store.test.ts) 的 `does not write initial candidates or AI proposals into product memory`；[tests/e2e/flow.spec.ts](./tests/e2e/flow.spec.ts)。[VALIDATION.md](./VALIDATION.md) 有 2026-10-04 历史成功与 2026-10-08 请求5的人工语义核对。

### GC-03：正常状态与暂停状态不同，不能误判直接冲突

- **输入**：P0-A：“正常监督中离席扣心。”P0-B：“暂停监督时不检测、不扣心。”
- **正确行为**：若状态互斥且含义明确，不报告两条规则之间的直接冲突；状态关系不清时澄清，而不是判定一定冲突。
- **错误行为**：仅因出现“扣心”和“不扣心”就报 conflict；或没有依据却默认状态互斥。
- **当前自动测试覆盖**：部分。Store 测试接收人为提供的澄清和分状态 pass 结果，证明后端允许该表达；不验证模型能正确区分状态。2026-10-08 请求6未把正常/暂停规则误报成冲突，属于人工核对的有限样例，不是系统性自动语义回归集。
- **对应位置**：[tests/store.test.ts](./tests/store.test.ts) 的 `treats uncertain consistency as clarification and accepts separate states`；[tests/fixtures.ts](./tests/fixtures.ts) 的 `makeAnalysis`；历史记录见 [VALIDATION.md](./VALIDATION.md)。

### GC-04：Proposal 未经接受不能成为产品事实

- **输入**：模型提出“每连续监督 30 分钟获得 60 秒免罚机会”。用户只选中方案、查看汇总，或提交 D 自定义想法，没有接受解决规则。
- **正确行为**：建议可以存在建议表和汇总中；`confirmedException` 不变；冲突解决规则待用户正式接受，随后重新审查。
- **错误行为**：选中即写入例外；D 答复直接成为确认例外；模型偷偷把这条建议放进 `coreRule`。
- **当前自动测试覆盖**：例外通道直接覆盖。普通回答不能接受冲突方案、手动首次写例外被拒绝、批量无确认文字被拒绝、预览汇总不写入、有效接受后旧 Review 失效均有测试。新增关系阶段只按明确接受的方案精确更新旧字段；冲突自定义答复仍不能替代接受。新功能与已授权字段的文字含义没有通用语义求解器。
- **对应位置**：[tests/store.test.ts](./tests/store.test.ts) 的 `cannot bypass proposal confirmation through draft payload`、`requires active proposal acceptance, then invalidates review until reanalysis`；[tests/concept.test.ts](./tests/concept.test.ts) 的 `never applies conflict choices through ordinary answer submission`；[tests/decisions.test.ts](./tests/decisions.test.ts) 的 `requires explicit proposal confirmation, including a proposal-only batch`；[tests/e2e/workspace.spec.ts](./tests/e2e/workspace.spec.ts) 第一项。

### GC-05：“暂不确定”应持续阻止 Ready

- **输入**：用户提交某个 `unsure:true` 选项，下一轮模型省略这个问题并给全部 Gate pass。
- **正确行为**：后端保留台账、恢复问题及对应未通过 Gate；设想不能确认，候选不能 Ready 或 Commit。
- **错误行为**：把暂不确定当确定选择，或因模型遗漏放行。
- **当前自动测试覆盖**：0.2.2 持久台账跨手动编辑保留未决定，模型省略继续阻塞；合法后续决定可关闭，但不能引用“暂不确定”消息。机制测试覆盖设想、候选、手动编辑和持久化。D 的复杂未决定表达仍依赖 AI，引用充分性不是程序证明。
- **对应位置**：[tests/methodology.test.ts](./tests/methodology.test.ts) 的 `does not close undecided questions with the undecided message, but accepts a later actual decision`；[tests/concept.test.ts](./tests/concept.test.ts)；[tests/e2e/restart.spec.ts](./tests/e2e/restart.spec.ts)。

### GC-06：真实摄像头识别不能声称 Agent 完全验证

- **输入**：“摄像头应正确判断真人是否在座，并让玩偶显示巡查反馈。”
- **正确行为**：代码或模拟可以验收逻辑，但真人入镜、离镜和实际反馈需要 Human 或 Hybrid；写清人工步骤、可观测方式与预期。
- **错误行为**：只写 Agent 模拟测试，声称已证明真实摄像头识别和体验正确。
- **当前自动测试覆盖**：部分。测试替身给摄像头 Human / Hybrid，浏览器能显示对应要求；类型必填规则有测试。2026-10-08 请求2/3/4给出 Hybrid，属于有限人工语义核对。没有“摄像头文本配 Agent 应被后端拒绝”的自动测试，后端也不会仅因业务类型不合适而拒绝 Agent 定义。
- **对应位置**：[tests/fixtures.ts](./tests/fixtures.ts) 的 `makeAnalysis`、`makeConceptP0Analysis`；[tests/store.test.ts](./tests/store.test.ts) 的 `Verification definitions` 测试组；[tests/e2e/concept.spec.ts](./tests/e2e/concept.spec.ts) 第一项；原则在 `reviewInstructions`。

### GC-07：“应该正常”不是充分 Verification

- **输入**：验证步骤“检查一下”；预期结果“应该正常”，没有具体输入、观察行为或判定标准。
- **正确行为**：Verifiability 不通过；整理明确的验证过程与结果，必要时提出问题。
- **错误行为**：仅因两段文字非空而认可验收充分，允许 Ready。
- **当前自动测试覆盖**：0.2.2 直接覆盖：常见独立空泛预期（包括“应该正常”）使 Verifiability 不通过并产生回答入口。没有穷尽验收语义检测，“检查一下”及复杂空泛表达仍依赖模型。2026-10-07 非空文字放行是旧版本历史证据。
- **对应位置**：[tests/methodology.test.ts](./tests/methodology.test.ts) 的 `rejects vague expected results even if every model gate passes`；[shared/domain.ts](./shared/domain.ts) 的 `verificationProblem`。

### GC-08：编辑规则后，旧 Review 和旧预览必须失效

- **输入**：某修订已经 Ready 并生成预览；用户保存新的规则或意图。旧模型结果迟到，或用户用旧修订请求 Commit。
- **正确行为**：递增修订、清除旧 Review；拒绝旧结果和旧预览提交，保存的新内容不被覆盖；重新整理、重新预览、重新确认。
- **错误行为**：继续显示已明确；旧模型覆盖新规则；勾选或旧预览继续提交。
- **当前自动测试覆盖**：直接覆盖 Store、API、界面状态及预览勾选刷新不恢复。测试中具体修改过意图/描述等产品字段，走的是规则修改共用的保存与修订路径。
- **对应位置**：[tests/store.test.ts](./tests/store.test.ts) 的 `invalidates review and rejects the old preview and late AI responses after editing`；[tests/api.test.ts](./tests/api.test.ts) 的 `does not apply a late analysis after an edit`、`never applies a cancelled result even when a provider returns it late`；[tests/baseline-text.test.ts](./tests/baseline-text.test.ts) 的导航用例；[tests/e2e/workspace.spec.ts](./tests/e2e/workspace.spec.ts)。

### GC-09：P0 编号保留，也不能换掉功能含义

- **输入**：已确认“玩偶随机巡查”和“离席扣心”。模型仍返回 P0-1、P0-2，却把内容改成“任务列表”和“完成奖励”。
- **正确行为**：拒绝静默替换意图，继续保留用户确认的功能含义；缺失信息用问题处理。
- **错误行为**：认为 id 数量相同就等于保留了全部功能，接受替换后的字段并 Ready。
- **当前自动测试覆盖**：部分。直接覆盖删除项、重复 id、未知/不完整集合和 source 改动的拒绝。0.3.0 新增阶段还逐字段保护未授权的已有 P0 和验收，拒绝模型静默改写。首次草稿或已获授权调整的功能仍允许普通字段整理，没有自动检查“同 id 内容换成另一个功能”的全部语义，保真仍需 Prompt 和最终用户复核。
- **对应位置**：[tests/store.test.ts](./tests/store.test.ts) 的 `does not silently delete, merge or rename source IDs`；[tests/concept.test.ts](./tests/concept.test.ts) 的 `freezes confirmed P0 IDs and sources and locks the intake stage`；缺口在 `Store.applyAnalysis`。

### GC-10：部分回答后，剩余问题不能因模型遗漏而算已解决

- **输入**：当前有“离席多久扣心？”、“每次扣几颗心？”两题。用户只确认第一题，没有对第二题选择，也没有提交“暂不确定”；下一轮模型省略第二题并填入数量。
- **正确行为**：第一题保存；第二题保持待决定，或明确展示为何已有其他用户资料足以解决，不能自行编造数量并 Ready。
- **错误行为**：旧 Review 被清除后，下一轮零问题就视为全都决定完。
- **当前自动测试覆盖**：0.2.2 直接覆盖问题台账：未答与待审查问题不会随 Review 清除，省略继续阻塞；后续用户资料可逐题关闭，出处/角色/原文/时间顺序和整批回滚有断言。引用是否真的回答了问题仍依赖 AI。2026-10-07 的遗漏放行是旧版本历史缺口。
- **对应位置**：[tests/methodology.test.ts](./tests/methodology.test.ts) 的 `retains ordinary unanswered questions across omission, partial answers, manual saves and reanalysis`、`closes an unanswered question using later user feedback and keeps the reason outside Baseline`、四类伪造证据测试；[tests/e2e/methodology.spec.ts](./tests/e2e/methodology.spec.ts)。

### GC-11：个人 MVP 使用最小充分验收

- **输入**：“个人本机自律监督工具，只要实现真人在场与离席扣心主流程；没有生产指标、防欺骗或复杂环境要求。”
- **正确行为**：用模拟状态/时间检查已确认扣心规则，真人入镜、离镜观察现有界面；覆盖必要边界，不主动要求照片攻击、标注数据集、环境矩阵、统计报告或额外日志系统。用户明确提出进阶要求时才处理。
- **错误行为**：默认追加高成本验收，把生产质量体系当作个人 MVP 必须完成的条件；或为了简化而只写“应该正常”、忽略核心规则。
- **当前自动测试覆盖**：来源与空泛预期有机制测试，整体最小充分程度和实现负担没有程序判定器，必须核对实际输出；Runtime Prompt 不是强保证。
- **对应位置**：[server/provider.ts](./server/provider.ts) 的 `reviewInstructions`；[scripts/verify-methodology.ts](./scripts/verify-methodology.ts) 的第 1、2 个内容样例；实际结果见 [VALIDATION.md](./VALIDATION.md)。

### GC-12：不能发明指标，不能把模拟数字当用户指标

- **输入**：A：没有质量指标要求；模型却提出“20 个样本，误报率≤5%”。B：用户明确要求“误报率≤5%，20 个样本”。C：用户要求误报率，但没有门槛。另有程序模拟“20 秒”作为测试输入。
- **正确行为**：A 拒绝无来源指标，不因没有指标阻塞；B 保存正式量化要求并逐项核验用户引用，预览/复制包含指标，不包含来源；C 使用自定义问题、未知 null/未定义，必要门槛缺失继续阻塞；模拟时间可以构造。
- **错误行为**：从模型建议/旧 AI 草稿取授权，借用其他项目数字；用“未定义”冒充充分量化验收；禁止所有模拟数字；漏掉已确认指标或把审查证据复制给 Agent。
- **当前自动测试覆盖**：结构化指标引用缺失、数字不符、assistant/其他项目引用与常见无来源指标表述均有机制覆盖；合法指标、未知值、自定义答复、模拟输入、正式复制亦覆盖。比较符、分母和复杂自然语言含义没有完整证明，指标遗漏检测仍主要靠 AI/用户。
- **对应位置**：[server/evidence.ts](./server/evidence.ts)；[tests/methodology.test.ts](./tests/methodology.test.ts) 的 `Quantitative provenance and complete options`；[tests/e2e/methodology.spec.ts](./tests/e2e/methodology.spec.ts)；[scripts/verify-methodology.ts](./scripts/verify-methodology.ts) 第 3、4 个样例。

### GC-13：确定选项必须是一份可以落实的决定

- **输入**：普通业务澄清的 A 为“我会补充监督范围”，B 为“稍后确定离席时长”；或用户要求量化指标但未给数字。
- **正确行为**：普通 A/B/C 给完整、可直接确认的业务方案；没有合理方案或未知用户指标时 custom_only，C 暂不确定＋D 输入，可重新生成选项。用户选择完整方案后不再要求补同一个决定。
- **错误行为**：把未完成承诺算成已答，强制用户再写一遍；为凑 A/B/C 编造指标；普通选项无预选却被模型提前应用。
- **当前自动测试覆盖**：后端拒绝常见“我会补充/稍后确定/之后确定”等确定选项，custom_only 的伪造 A 拒绝；浏览器覆盖完整方案选择、自定义、部分回答、键盘和移动端。新增关系浏览器还覆盖未成功生成方案时没有占位 C/D，刷新保留与主动重试；过期方案明确提示重新生成。方案是否真的完整、合理和无重复仍依赖 AI，未穷尽所有承诺表达。六次真实调查后又细化了普通产品参数优先给完整选项的 Prompt；预算已用完，该最后调整未追加真实验证。
- **对应位置**：[server/store.ts](./server/store.ts) 的 `validateOptions`；[tests/methodology.test.ts](./tests/methodology.test.ts)；[tests/e2e/methodology.spec.ts](./tests/e2e/methodology.spec.ts)。

2026-10-09 隔离机制补充：[tests/question-coverage.test.ts](./tests/question-coverage.test.ts) 覆盖一题关联多个 Gate、不完整审查整轮回滚、不同决定保留、旧契约兼容、显式合并历史与权限、最新答复及同批跨题先后保护。C 和仅委托 AI 的答复继续阻塞；合并不能绕过冲突接受。[tests/e2e/question-merge.spec.ts](./tests/e2e/question-merge.spec.ts) 覆盖无预选、键盘、刷新、窄屏、保存后审查失败及主动重试。GC-04/05/08/10 的相关断言保留。本轮真实模型调用为零，不证明所有语义重复都能被模型识别或内容判断充分。

### GC-14：新增设想先确认归属，不能自动增加或重复建立 P0

- **输入**：已有监督基线，用户提出“加入暂停按钮”；另一次提出“补充监督规则，暂停时不检测”。
- **正确行为**：AI 读取当前基线，说明独立新能力或已有 P0 补充的归属与关联。建议只是工作资料；用户明确确认后才创建稳定新编号或确定原 P0，不建立重复功能，也不授权覆盖旧规则。一次多项能力逐项确认，不强行合成单项；独立审查新旧关系，有变更明确接受方案，无冲突且不改旧规则直接进完整 MVP；意图不清保留待确认，参数留给业务审查。
- **错误行为**：保存设想或 AI 判断后自动增加 P0；未经确认写入旧功能；所有补充都强制新建功能；引用不存在的目标。
- **当前自动测试覆盖**：隔离 Store/API/browser 覆盖建议未确认时成员不变、确认后新建、现有补充不重复、无效引用/过期结果拒绝；归属确认不会直接授权覆盖旧字段。限定真实玩偶案例及结果见 VALIDATION；归属是否合理仍依赖 AI 与用户，不能从一例推广到全部功能。
- **对应位置**：[tests/addition.test.ts](./tests/addition.test.ts)、[tests/addition-api.test.ts](./tests/addition-api.test.ts)、[tests/e2e/addition.spec.ts](./tests/e2e/addition.spec.ts)；`Store.applyAdditionAssessment`、`Store.confirmAddition`。

### GC-15：新增功能必须关联全量旧功能审查，旧规则不能静默被缩窄

- **输入**：旧 P0 正常监督实时检测，新功能只有玩偶随机出现时检测；另例为暂停不检测。模型为消除冲突，直接缩窄旧判定条件，用户没有确认这种改动。分别测试新建 P0 和归入已有 P0。
- **正确行为**：读取全量 P0，未授权旧 fields/Verification 通过显式原文引用保留并重新审查四 Gate；需要改边界先提业务决定，真实冲突使用独立 Proposal，主动接受后统一审查；所有未解决台账继续阻塞。最终预览显示旧功能变化。
- **错误行为**：只审新功能、不关联旧规则；缩窄旧状态后全部 pass；省略台账放行；自定义冲突答复直接改写旧规则或关闭冲突。
- **当前自动测试覆盖**：保护旧字段、完整集合、冲突暂不确定/省略持续阻塞、有效方案接受再审查、旧基线不变有隔离断言；Provider 输入包含完整基线、草稿和新增原文。[tests/review-contract.test.ts](./tests/review-contract.test.ts) 覆盖首次/后续统一固定 P0 键、重复 JSON 键、全量 Gate、字段权限、脱敏诊断及历史题不能重复关闭。旧失败草稿保留编号和答复恢复独立关系阶段，不把占位 C/D 作为业务选择。[tests/addition-conflict.test.ts](./tests/addition-conflict.test.ts) 验证同 P0 冲突需接受，未受影响字段继承、规则变动重建验收，自定义/省略/暂不确定不放行，以及同字段不同方案整批回滚；完整 MVP 答复仅开放汇总中列出的 affectedFields，不能附带修改无关 Purpose 或描述。同 P0 冲突已在浏览器验证；真实限定结果见 VALIDATION，不能推广为发现所有冲突或保证已授权文字语义忠实。
- **对应位置**：[tests/addition.test.ts](./tests/addition.test.ts) 的多项/混合归属、无冲突直接进入、失败恢复与快照用例；[tests/addition-api.test.ts](./tests/addition-api.test.ts)；`Store.applyAnalysis`、`TaskProvider.analyze`。

### GC-16：新版本确认前当前基线有效，历史快照、放弃与恢复可靠

- **输入**：v1 已提交；新增草稿 Ready 后编辑、取消、放弃或重启；最终主动确认生成 v2，重复请求，再新增 v3。
- **正确行为**：草稿期间 v1 有效，旧预览/迟到结果不能提交或覆盖；放弃恢复已确认内容。新版本须当前 Gate/台账/验收通过及新确认文案，事务追加，重试幂等。历史原文不改，最新为当前，可阅读/原文复制，实际重启后草稿和所有版本恢复。
- **错误行为**：一开始就替换基线；在原 v1 行上覆盖；重复提交产生两个版本；放弃删除历史；历史选择回滚当前；复制混入未确认工作资料。
- **当前自动测试覆盖**：v1 原始 payload、v2/v3 顺序、幂等、数据库只读、放弃/旧修订拒绝、进程恢复和历史/当前原文复制都有隔离机制或 Edge 浏览器断言；新增阶段与待决定的关系问题也在实际进程重启后恢复，继续阻止预览，明确处理后再生成 v2。真实限定内容结果单独记录，没有历史回滚功能。
- **对应位置**：[tests/addition.test.ts](./tests/addition.test.ts)、[tests/addition-api.test.ts](./tests/addition-api.test.ts)、[tests/e2e/addition.spec.ts](./tests/e2e/addition.spec.ts)、[tests/e2e/restart.spec.ts](./tests/e2e/restart.spec.ts)；`Store.commit`、`Store.discardAddition`、`Store.readBaseline`。

### GC-17：换连接不改变产品决定，也不能绕过完整审查

- **输入**：已有项目从 ChatGPT 切换 OpenAI / DeepSeek / GLM；用户保存或更换 Key，测试连接，所选模型失效、截断、返回自由文本/缺失字段；审查中尝试修改配置。
- **正确行为**：只用明确选择的连接与模型；保存 Key 不推理，测试需主动点击且只调用一次。Key 加密不回显；切换不删除其他连接。思考设置符合模型能力，模型目录加载/失效不能冒充有效模型。所有任务共用严格本地结构和 Store 业务校验；失败/取消/超时不改草稿、不换厂商/自动重试；运行期间前后端阻止改配置。首次和新版本均走现有 Gate、决定、预览与确认，基线不含连接设置或凭据。
- **错误行为**：把“已配置”当作验证成功；自动使用另一厂商额度；对 GLM 自由文本截取/补字段；仅审新功能；Key 进入 localStorage、日志或产品输入；响应未完成就应用。
- **当前自动测试覆盖**：[tests/ai.test.ts](./tests/ai.test.ts) 使用隔离凭据、真实 DPAPI与模拟官方响应，覆盖三家 API 的四个任务协议、严格校验、错误/取消/超时/配置锁与密文恢复；新增同目录的独立凭据锁、Windows 密文替换占用恢复/持续失败保留、ChatGPT 状态等待不阻塞 API 配置、目录去重/过期/主动刷新/Key 与账号变更失效，以及旧账号状态迟到保护。原 ChatGPT Provider 测试覆盖四个任务。[tests/e2e/ai.spec.ts](./tests/e2e/ai.spec.ts) 覆盖统一 UI、能力、切换/刷新、失效模型阻止审查、Key 清空/脱敏及 API 连接的 v1 → 新增 → v2；[tests/e2e/concept.spec.ts](./tests/e2e/concept.spec.ts) 核对确认前澄清与确认后审查的提示及阶段限制；浏览器 Provider 为测试替身。
- **未验证**：本轮三家 API 没有使用用户真实 Key，不证明其实际模型权限、真实接入或输出语义。ChatGPT 的限定玩偶案例独立记录于 VALIDATION，不代表所有厂商表现。GC-01～GC-16 的通用语义边界保持，结构成功不能代替审查正确性。
