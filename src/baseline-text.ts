import type { Baseline } from '../shared/domain';

export function baselineText(name: string, baseline: Baseline): string {
  const section = (title: string, value: string) => `### ${title}\n\n${value}\n`;
  return [
    '请根据以下已确认的产品基线实现 MVP，保留全部功能、规则和验收要求；遇到阻止实现的未明确问题时，请向我确认。',
    `# ${name} — Baseline ${baseline.baselineVersion}`,
    `提交时间：${baseline.createdAt}`,
    section('产品是什么', baseline.productDescription),
    section('使用场景 / 用户目标', baseline.coreUserGoal),
    section('核心产品设定', baseline.productConcept || '旧版本未记录产品设定'),
    baseline.baselineVersion === 'v1' ? '## 第一版 MVP 功能' : '## 当前产品功能',
    ...baseline.p0Items.map(c => {
      const v = c.verification;
      return [
        `## ${c.id} · ${c.name}`,
        section('功能描述', c.description), section('用户意图', c.purpose),
        section('生效状态 / 条件', c.applicableState), section('完整规则与边界', c.coreRule),
        section('已确认例外 / 冲突解决规则', c.confirmedException || '无已确认例外'),
        v ? `### 验收要求（${v.type}）` : '### 验收要求\n\n旧版本未记录验收要求',
        ...(v && (v.type === 'Agent' || v.type === 'Hybrid') ? [section('Agent 验证步骤', v.agentProcess), section('预期 Agent 结果', v.expectedAgentResult)] : []),
        ...(v && (v.type === 'Human' || v.type === 'Hybrid') ? [section('Agent 可以检查什么', v.agentSideReview), section('人工测试步骤', v.humanTest), section('可观测要求', v.observability), section('预期人工结果', v.expectedHumanResult)] : []),
        ...(v?.quantitativeRequirements?.map(q => section(`量化验收 · ${q.metric}`, `门槛：${q.target ?? '未定义'}\n\n样本要求：${q.sample ?? '未定义'}`)) ?? []),
      ].join('\n\n');
    }),
  ].join('\n\n');
}
