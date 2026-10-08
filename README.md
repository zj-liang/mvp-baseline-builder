<img src="docs/assets/logo.svg" alt="MVP Baseline Builder" width="48" height="48">

# MVP Baseline Builder

把模糊的产品设想，整理成你确认过、可以交给开发 Agent 的产品基线。

这是一个在 Windows 本机运行的中文工具。你描述想做什么，AI 整理产品定义、找出需要决定的问题；你确认规则，再把完整的第一版产品逻辑保存下来。后续加入功能，可以在保留旧基线的情况下继续形成新版本。

[看完整演示](docs/DEMO.md) · [读产品设计案例](docs/CASE_STUDY.md) · [下载源码 ZIP](https://github.com/zj-liang/mvp-baseline-builder/archive/refs/heads/main.zip) · [本地运行](#本地运行)

![MVP 梳理：产品摘要和功能审查状态](docs/assets/02-workspace.png)

*以上是实际应用界面，使用隔离示例数据与模拟 AI。示例中的自律监督工具是待梳理的产品设想，本应用没有实现摄像头监督或扣心功能。*

## 从一句话开始

它更适合这样的使用者：有一个小产品想法，准备借助 AI 开发，但还不习惯把行为、边界和验收要求说清楚。你可能能描述“用起来应该是什么感觉”，却还不知道开发前有哪些决定需要自己做。

“我想做一个自律监督工具，离席会扣心，但短暂离席可以免罚。”

这句话可以描述体验，却还不能直接交给开发：离席多久算违规？免罚与扣心是否同时生效？摄像头不可用时怎么办？这些决定会改变产品行为，需要使用者想清楚并确认。

应用把这段过程分成三步：**产品设想 → MVP 梳理 → 最终确认**。确认后得到只读的 Baseline v1，可以复制完整 Markdown 给开发 Agent。加入新功能时，先确认功能归属与新旧规则，再完整审查、预览和提交 Baseline v2。新版本提交前，旧基线继续有效。

演示中的每一步和最终输出见[界面导览](docs/DEMO.md)，也可以直接阅读[示例 Baseline v1](docs/examples/baseline-v1.md)。

这个项目想提供的帮助，是让个人构建者在动手之前，有一处可以逐步想清楚规则、保留未决定事项，再确认完整版本的地方。适合先做一个范围有限的 MVP；它不会替你判断想法有没有市场，也不会直接生成或测试你的产品代码。这里描述的是设计目标，目前还没有用户研究来证明适用人群或使用收益。

## 几个有意保留的设计

- **决定由用户确认。** 选项没有默认选择；AI 的冲突解决方案先作为建议保存，明确接受后才生效。“暂不确定”继续留在问题台账中。
- **审查分成四项。** 清晰度、边界、直接一致性、可验证性分别保存状态和依据。同一个业务问题可以关联多项审查，避免按字段重复提问。
- **旧结论有有效期。** 修改规则或答复后，旧审查和预览失效。AI 关闭问题时，证据不能早于该题最新答复。
- **交付使用已确认的原文。** 基线保留稳定 P0 编号、规则、已接受例外和验证要求；复制时不重新总结，不带入聊天、未接受建议或认证信息。

这些选择，以及一次重复提问问题的修复，写在[产品设计案例](docs/CASE_STUDY.md)中。

## 本地运行

需要 **Windows、Node.js 24.5.0 或更高版本**，以及使用者自己的 AI 连接。Node.js 版本要求和 pnpm 版本以 `package.json` 为准。

下载 ZIP 并解压后，在包含 `package.json` 的文件夹打开 PowerShell。也可以克隆仓库：

```powershell
git clone https://github.com/zj-liang/mvp-baseline-builder.git
cd mvp-baseline-builder
```

安装依赖、构建并启动：

```powershell
$taskPackageManager = (Get-Content ./package.json -Raw | ConvertFrom-Json).packageManager
npm install --global $taskPackageManager
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

浏览器打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。在 AI 连接中选择 ChatGPT 账号、OpenAI API、DeepSeek API 或智谱 GLM API，配置自己的账号或 Key。AI 整理需要联网；源码下载不附带账号或模型额度。

这是源码运行方式，还没有双击安装包。当前凭据加密依赖 Windows；服务只监听本机，不是公开托管的在线应用。

端口占用、模型设置、本地数据和恢复方法见[使用说明](docs/USER_GUIDE.md)。

## 如何检查这个项目

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

浏览器回归使用 Microsoft Edge；测试使用隔离数据和模拟 Provider，不调用真实模型。Windows CI 执行类型检查、单元／集成测试和构建。

程序可以检查修订号、证据出处、事务、确认与提交条件。自然语言是否充分、冲突有没有遗漏，仍需要模型判断和用户复核。四项审查通常来自同一次请求，不是四个模型独立投票，也不是形式化证明。

带日期的实际结果、有限真实模型样例与未验证项保留在[验证记录](VALIDATION.md)。

| 想了解什么 | 从这里开始 |
| --- | --- |
| 为什么这样设计 | [产品案例](docs/CASE_STUDY.md) |
| 界面如何走到正式输出 | [演示与示例](docs/DEMO.md) |
| 使用、安装和数据管理 | [使用说明](docs/USER_GUIDE.md) |
| 状态、存储与后端保护 | [架构说明](ARCHITECTURE.md) |
| 当前实现与保证边界 | [产品实现指南](PRODUCT_IMPLEMENTATION_GUIDE.md) |
| 登录、模型与网络问题 | [AI 连接说明](AUTH_AND_MODELS.md) |
| 测试证据与方法论案例 | [验证记录](VALIDATION.md)、[Golden Cases](Golden%20Cases.md) |

## 发布与许可

这个个人项目采用 AI 辅助开发，代码并非全部手写。公开仓库以当前 **0.4.0** 完整源码作为首次发布快照；首次提交时间表示公开发布时间，不表示项目开发起点。详细验证记录保留真实日期。

原创部分按 [PolyForm Noncommercial 1.0.0](LICENSE) 授权，允许许可范围内的非商业使用、修改和分享。第三方代码、字体和品牌资源保留各自许可；DevKit 的修改继续遵守其原非商业许可，详见[许可范围与来源](docs/LICENSING.md)。本项目不代表任何模型厂商的官方产品。
