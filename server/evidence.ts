import type { Analysis, Evidence, Project } from '../shared/domain.js';
import { sameVerification, undecidedAnswer, questionGates } from '../shared/domain.js';
import { AppError } from './errors.js';

export function userEvidence(project: Project, evidence: Evidence[], after?: string | null): string {
  const boundary = after ? project.conversation.findIndex(m => m.id === after) : -1;
  return evidence.map(ref => {
    const index = project.conversation.findIndex(m => m.id === ref.messageId);
    const message = project.conversation[index];
    if (!message || message.role !== 'user' || !ref.quote.trim() || !message.content.includes(ref.quote) ||
        (after !== undefined && index <= boundary) || /"undecided":true/.test(message.content) ||
        undecidedAnswer(ref.quote)) {
      throw new AppError('invalid_evidence', '用户资料引用无效、早于问题或仍未决定，结果未应用。', 502);
    }
    try {
      const body = JSON.parse(message.content) as { answer?: string; changes?: Array<{ after: unknown }> };
      if (body.answer && undecidedAnswer(body.answer)) throw new AppError('invalid_evidence', '请求 AI 提供方案不是已确认产品规则，结果未应用。', 502);
      if (body.changes && !body.changes.some(c => (typeof c.after === 'string' ? c.after : JSON.stringify(c.after)).includes(ref.quote))) {
        throw new AppError('invalid_evidence', '手动编辑引用必须来自实际变更后的当前内容，不能引用 before 历史值。', 502);
      }
    } catch (error) { if (error instanceof AppError) throw error; }
    return ref.quote;
  }).join('\n');
}

const numbers = (value: string) => value.match(/\d+(?:\.\d+)?\s*%?/g)?.map(s => s.replaceAll(' ', '')) ?? [];
const metricExpressions = (text: string) => text.match(/(?:误报率|漏报率|准确率|召回率|成功率|识别率|P95|P99|响应时间|延迟)[^。；\n]{0,24}?\d+(?:\.\d+)?\s*(?:%|毫秒|ms|秒)|(?:至少|不少于|>=|≥)\s*\d+\s*(?:个|组|次)?\s*(?:样本|真人|测试|试验)|\d+\s*(?:个|组|次)?\s*(?:标注样本|测试样本|样本)/gi) ?? [];
const compact = (s: string) => s.replace(/\s/g, '').replace(/≤/g, '<=').replace(/≥/g, '>=');

// This validates provenance and common expressions, not the meaning of all prose.
export function validateQuantitative(project: Project, result: Analysis): void {
  for (const item of result.items) {
    // Previously committed, unchanged verification is already confirmed product
    // content, including old snapshots whose working provenance is unavailable.
    const established = project.addition && project.baseline?.p0Items.find(c => c.id === item.id);
    if (established && sameVerification(established.verification, item.verification)) continue;
    const requirements = item.verification?.quantitativeRequirements ?? [];
    const sources = item.quantitativeSources;
    if (sources.length !== requirements.length || new Set(sources.map(s => s.requirementIndex)).size !== sources.length) {
      throw new AppError('invalid_metric_source', '量化验收要求必须逐项引用用户资料。', 502);
    }
    for (let i = 0; i < requirements.length; i++) {
      const requirement = requirements[i]!, source = sources.find(s => s.requirementIndex === i);
      if (!source) throw new AppError('invalid_metric_source', '量化要求引用缺失。', 502);
      const quote = userEvidence(project, source.evidence);
      if (!compact(quote).includes(compact(requirement.metric)) ||
          [...numbers(requirement.target ?? ''), ...numbers(requirement.sample ?? '')].some(n => !numbers(quote).includes(n))) {
        throw new AppError('invalid_metric_source', '指标名称、门槛或样本数缺少对应用户原文，结果未应用。', 502);
      }
      if (requirement.target !== null && !requirement.target.trim() || requirement.sample !== null && !requirement.sample.trim()) {
        throw new AppError('invalid_metric_source', '未约定量化值请使用 null。', 502);
      }
    }
    if (requirements.some(r => !r.target?.trim()) && result.issues.some(q => q.p0Ids.includes(item.id) && questionGates(q).includes('verifiability') && q.answerMode !== 'custom_only')) {
      throw new AppError('invalid_analysis', '用户指标尚缺门槛时必须使用自定义回答，不能提供猜测数值选项。', 502);
    }
    const prose = item.verification ? Object.values(item.verification).filter(v => typeof v === 'string').join('\n') : '';
    for (const expression of metricExpressions(prose)) {
      if (!project.conversation.some(m => m.role === 'user' && compact(m.content).includes(compact(expression)))) {
        throw new AppError('unsupported_metric', '验收说明包含没有用户来源的指标或样本规模，结果未应用。', 502);
      }
      if (!requirements.length) throw new AppError('invalid_metric_source', '量化指标必须使用结构化要求并引用用户原文。', 502);
    }
  }
}
