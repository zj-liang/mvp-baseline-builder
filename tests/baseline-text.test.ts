import { describe, expect, it } from 'vitest';
import { baselineText } from '../src/baseline-text.js';
import { candidateStatus, restoredView } from '../src/navigation.js';
import { Store } from '../server/store.js';
import { makeAnalysis } from './fixtures.js';

describe('Agent handoff and user navigation', () => {
  it('copies every confirmed field, full multiline rules and all Agent/Human/Hybrid requirements', () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ name: '复制测试', productDescription: '产品定义', coreUserGoal: '场景', productConcept: '核心设定', features: ['Human', 'Agent', 'Hybrid'] });
      const analysis = makeAnalysis(p);
      analysis.items[2]!.verification = { ...analysis.items[1]!.verification!, ...analysis.items[0]!.verification!, type: 'Hybrid', agentProcess: '混合程序步骤', expectedAgentResult: '混合程序预期' };
      const project = store.applyAnalysis(p.id, p.revision, analysis);
      const baseline = store.preview(p.id, project.revision);
      baseline.createdAt = '2026-10-05T00:00:00.000Z';
      baseline.p0Items[0]!.coreRule = '# 原始规则\n第二行\n' + '长规则'.repeat(2500);
      baseline.p0Items[1]!.confirmedException = '已接受的例外';
      const before = JSON.stringify(baseline), text = baselineText(p.name, baseline);
      for (const value of [p.name, baseline.createdAt, baseline.productDescription, baseline.coreUserGoal, baseline.productConcept!]) expect(text).toContain(value);
      for (const c of baseline.p0Items) {
        for (const k of ['id', 'name', 'description', 'purpose', 'applicableState', 'coreRule', 'confirmedException'] as const) if (c[k]) expect(text).toContain(c[k]);
        for (const v of Object.values(c.verification!)) if (v) expect(text).toContain(v);
      }
      expect(text).not.toMatch(/conversation|proposals|accessToken|source/);
      expect(JSON.stringify(baseline)).toBe(before);
      delete baseline.productConcept;
      expect(baselineText(p.name, baseline)).toContain('旧版本未记录产品设定');
    } finally { store.close(); }
  });
  it('maps legacy navigation and never labels unreviewed or edited features as clear', () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ name: 'nav', productDescription: 'product', coreUserGoal: 'goal', features: ['one'] });
      expect(candidateStatus(p, p.draft.candidates[0]!, false)).toBe('待整理');
      const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
      for (const legacy of ['1', '2', '3', '4', '6']) expect(restoredView(reviewed, null, legacy)).toBe('workspace');
      expect(restoredView(reviewed, null, '5')).toBe('confirm');
      expect(restoredView(p, 'confirm', null)).toBe('workspace');
      expect(candidateStatus(reviewed, reviewed.draft.candidates[0]!, false)).toBe('已明确');
      expect(candidateStatus(reviewed, reviewed.draft.candidates[0]!, true)).toBe('待整理');
      const legacy = { ...reviewed, review: { ...reviewed.review! } }; delete legacy.review.ledgerVersion;
      expect(candidateStatus(legacy, legacy.draft.candidates[0]!, false)).toBe('待整理');
      expect(restoredView(legacy, 'confirm', null)).toBe('workspace');
      expect(restoredView({ ...reviewed, baseline: store.preview(p.id, reviewed.revision) }, 'concept', null)).toBe('baseline');
    } finally { store.close(); }
  });
});
