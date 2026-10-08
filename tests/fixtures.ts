import type { Analysis, ConceptAnalysis, DecisionOption, Gates, Project, GateKey } from '../shared/domain.js';
import type { Auth } from '../server/auth.js';
import { TaskProvider } from '../server/provider.js';
import type { Provider } from '../server/provider.js';
import { additionUpdateIds } from '../server/addition-review.js';

export const passGates = (): Gates => ({
  clarity: { status: 'pass', reason: '行为明确。' }, boundary: { status: 'pass', reason: '生效状态与核心边界明确。' },
  consistency: { status: 'pass', reason: '没有未解决的直接产品逻辑冲突。' }, verifiability: { status: 'pass', reason: '已定义合理验证方式。' },
});
export const decisionOptions = (answers: [string, string], conflict = false): DecisionOption[] => [
  { key: 'A', label: '方案一', answer: answers[0], impact: '按第一个方案运行。', unsure: false, proposalIndex: conflict ? 0 : null },
  { key: 'B', label: '方案二', answer: answers[1], impact: '按第二个方案运行。', unsure: false, proposalIndex: conflict ? 1 : null },
  { key: 'C', label: '暂不确定', answer: '暂不确定', impact: '保持待决定，不会通过审查。', unsure: true, proposalIndex: null },
];
export function customIssue(gate: GateKey, p0Id: string, question: string): Analysis['issues'][number] {
  return { kind: gate === 'verifiability' ? 'verification' : 'clarification', gate, coveredGates: [gate], p0Ids: [p0Id], title: '明确产品决定', question, explanation: '需要用户明确这一决定。', condition: '', ruleA: '', ruleB: '', answerMode: 'custom_only', questionId: null, options: [decisionOptions(['unused', 'unused'])[2]!], proposals: [] } as Analysis['issues'][number];
}
export function resolutions(project: Project) {
  return project.questions.filter(q => q.stage === project.stage && q.status === 'pending_review' && (!('kind' in q.question) || q.question.kind !== 'conflict' || q.acceptedProposal)).flatMap(q => {
    const message = [...project.conversation].reverse().find(m => m.role === 'user' && m.content.includes(`"issueId":"${q.id}"`) && !m.content.includes('"undecided":true'));
    if (!message) return [];
    const data = JSON.parse(message.content);
    return [{ questionId: q.id, reason: '测试用户明确的答复提供了这项决定。', evidence: [{ messageId: message.id, quote: data.answer ?? data.rule }] }];
  });
}
export function makeConcept(project: Project): ConceptAnalysis {
  const decided = project.conversation.some(c => c.role === 'user' && c.content.includes('屏幕中的虚拟玩偶'));
  return { definition: { name: '自律玩偶', productDescription: '一个玩偶巡查与离席扣心的自律监督工具。', coreUserGoal: '用户在学习或工作时希望获得在场监督。',
    productConcept: decided ? '屏幕中的虚拟玩偶通过摄像头随机巡查，在监督中离席会扣心。' : '有玩偶随机巡查，监督期间离席会扣心。',
    features: [{ name: '玩偶随机巡查', description: '玩偶随机巡查用户的在场情况。' }, { name: '离席扣心', description: '监督期间离席会扣心。' }] },
    resolvedQuestions: decided ? resolutions(project) : [],
    questions: decided ? [] : [{ questionId: project.questions.find(q => q.status !== 'resolved')?.id ?? null, answerMode: 'choices', title: '玩偶是什么样的', question: '你设想的玩偶如何巡查？', reason: '虚拟形象与实体设备带来的体验和实现方式不同。',
      options: decisionOptions(['屏幕中的虚拟玩偶，通过摄像头巡查在场情况。', '一个实体玩偶，通过设备传感器巡查。']) }],
  };
}
export function makeConceptP0Analysis(project: Project): Analysis {
  const decided = project.conversation.some(c => c.role === 'user' && c.content.includes('监督开始为3颗心'));
  const items = project.draft.candidates.map((c, i) => ({ id: c.id, fields: {
    name: c.name, description: c.description, purpose: i === 0 ? '通过玩偶互动监督在场情况。' : '对离席行为给出明确反馈。',
    applicableState: '用户主动开始监督时生效，结束监督后不生效。',
    coreRule: decided ? (i === 0 ? '虚拟玩偶通过摄像头随机巡查；每次巡查间隔在10至30秒均匀随机，显示巡查结果。摄像头不可用则暂停监督且不扣心，恢复后由用户主动继续。' :
      '监督开始为3颗心；巡查发现无人则开始离席计时，连续无人超过10秒扣1颗心，每次离席只扣一次，回到画面后重新计时；恰好10秒不扣。0心停止并显示本轮结束，重新开始重置3颗心。') : '',
  }, verification: decided ? (i === 0 ? { type: 'Hybrid' as const, agentProcess: '模拟随机数与10至30秒计时，模拟摄像头断开。', expectedAgentResult: '巡查间隔在范围内，断开后暂停且不扣心。', agentSideReview: '检查摄像头和巡查显示逻辑。', humanTest: '真人入镜和离镜，观察玩偶巡查反馈。', observability: '显示巡查结果、状态及心数。', expectedHumanResult: '画面中玩偶反馈与真人在场一致。' } :
    { type: 'Agent' as const, agentProcess: '模拟10秒、11秒无人，持续无人和重新入座，扣到0心。', expectedAgentResult: '恰好10秒不扣，11秒只扣1心，同次不重复，0心结束；重新开始重置。', agentSideReview: '', humanTest: '', observability: '', expectedHumanResult: '' }) : null,
    quantitativeSources: [], gates: passGates(),
  }));
  return { items: items.map(i => ({ ...i, verification: i.verification ? { ...i.verification, quantitativeRequirements: [] } : null })), resolvedQuestions: decided ? resolutions(project) : [], issues: decided ? [] : [{ questionId: project.questions.find(q => q.stage === 'candidate' && q.status !== 'resolved')?.id ?? null, answerMode: 'choices', kind: 'clarification', gate: 'boundary', coveredGates: ['clarity', 'boundary', 'verifiability'], p0Ids: project.draft.candidates.map(c => c.id), title: '确定巡查与扣心规则',
    question: '你希望玩偶多久巡查、离席怎样扣心？', condition: '', ruleA: '', ruleB: '', explanation: '阈值和扣心方式会影响核心行为，不能由 AI 擅自确定。', proposals: [],
    options: decisionOptions(['每10至30秒随机巡查；监督开始为3颗心；巡查发现无人并连续超过10秒扣1颗心，同次离席只扣一次，回到画面重新计时；0心停止，重新开始重置。摄像头不可用时暂停且不扣心，恢复后主动继续。', '每30至60秒随机巡查；监督开始为3颗心；巡查发现无人并连续超过30秒扣1颗心，同次离席只扣一次，回到画面重新计时；0心停止，重新开始重置。摄像头不可用时暂停且不扣心，恢复后主动继续。']) }],
  };
}
export function makeAnalysis(project: Project, conflict = false): Analysis {
  const resolved = project.draft.candidates.some(c => c.confirmedException);
  return {
    resolvedQuestions: resolutions(project),
    items: project.draft.candidates.map((c, i) => ({ id: c.id,
      fields: { name: c.name, description: c.source, purpose: '帮助用户在自律时明确当前行为与结果。',
        applicableState: i === 2 && resolved ? '用户主动点击进入临时离席状态。' : '正常监督状态；暂停状态不执行普通离席规则。',
        coreRule: i === 0 ? '监督开始后持续显示摄像头识别的人体存在状态；暂停时不判定违规。' : i === 1 ? '连续超过 10 秒无人则扣一颗心；本次离席只扣一次，检测到人后重置离席计时。' : '允许离席 60 秒不扣心；超过 60 秒恢复普通监督。' },
      verification: i === 0 ? { quantitativeRequirements: [], type: 'Human' as const, agentProcess: '', expectedAgentResult: '', agentSideReview: '检查摄像头读取和状态更新逻辑。', humanTest: '真人坐在镜头前后离开镜头，对照当前识别状态。', observability: '开发时显示实时识别结果和当前监督状态。', expectedHumanResult: '有人和无人状态随实际情况变化，暂停时不判罚。' } :
        { quantitativeRequirements: [], type: 'Agent' as const, agentProcess: i === 1 ? '模拟正常监督连续 11 秒无人，再持续无人并重新入座。' : '模拟进入免罚状态，推进计时到 60 秒及超过 60 秒。',
          expectedAgentResult: i === 1 ? '只扣一颗心，入座后计时重置；暂停时不扣心。' : '允许时段不扣心，期限结束恢复普通监督。', agentSideReview: '', humanTest: '', observability: '', expectedHumanResult: '' },
      quantitativeSources: [], gates: passGates(),
    })),
    issues: conflict && !resolved ? [{ questionId: project.questions.find(q => q.stage === 'candidate' && q.status !== 'resolved')?.id ?? null, answerMode: 'choices', kind: 'conflict', gate: 'consistency', p0Ids: ['P0-2', 'P0-3'], title: '正常监督下的离席处罚与免罚冲突',
      condition: '正常监督状态，连续离席超过 10 秒但不足 60 秒。', ruleA: 'P0-2 要求扣一颗心。', ruleB: 'P0-3 要求不受处罚。', explanation: '同一状态和同一离席事件要求扣心与不扣心，当前不能同时成立。',
      question: '免罚离席是否应使用独立状态？请定义进入方式与时限。', options: decisionOptions(['主动进入临时离席状态，60秒内不执行普通扣心规则。', '正常监督中免罚规则优先，60秒后恢复普通扣心。'], true),
      proposals: [{ label: '增加临时离席状态', rule: '用户每连续监督 30 分钟获得一次临时离席机会；主动点击后进入临时离席状态，最多 60 秒，该状态不执行普通离席扣心规则，期满恢复普通监督。' },
        { label: '明确免罚优先级', rule: '主动启用60秒免罚期间普通离席扣心不生效，结束时重置无人计时。' }] }] : [],
  };
}
// Imported only by tests and the isolated E2E runner. Production never selects this provider.
export function makeBatchAnalysis(project: Project): Analysis {
  const result = makeAnalysis(project, true);
  if (project.draft.candidates.some(c => c.confirmedException.includes('第二条解决规则')) && project.conversation.filter(c => c.content.includes('批量决定')).length >= 4) {
    result.issues = []; return result;
  }
  const conflict = result.issues[0]!;
  result.issues = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...conflict, kind: 'clarification' as const, gate: 'boundary' as const,
      title: `批量问题 ${i + 1}`, question: `批量问题 ${i + 1} 如何运行？`, p0Ids: [project.draft.candidates[i % project.draft.candidates.length]!.id],
      options: decisionOptions([`批量决定 ${i + 1} A`, `批量决定 ${i + 1} B`]), proposals: [] })),
    ...['第一条解决规则', '第二条解决规则'].map(title => ({ ...conflict, title,
      proposals: conflict.proposals.map(p => ({ ...p, rule: title + '：' + p.rule })) })),
  ];
  return result;
}
export function makeMethodologyAnalysis(project: Project): Analysis {
  const result = makeAnalysis(project);
  const answer = [...project.conversation].reverse().find(m => m.role === 'user' && m.content.includes('误报率≤5%'));
  result.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: answer ? '≤5%' : null, sample: null }];
  result.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: answer?.id ?? project.conversation[0]!.id, quote: answer ? '误报率≤5%' : '用户要求误报率，门槛未定义' }] }];
  const templates: Analysis['issues'] = [
    { kind: 'clarification', gate: 'boundary', p0Ids: ['P0-1'], title: '显示范围', question: '在哪个状态显示？', condition: '', ruleA: '', ruleB: '', explanation: '明确核心显示范围。', answerMode: 'choices', questionId: null, options: decisionOptions(['仅正常监督状态显示。', '正常和暂停状态均显示。']), proposals: [] },
    { kind: 'verification', gate: 'verifiability', p0Ids: ['P0-1'], title: '用户要求的误报率', question: '你要求的误报率门槛是什么？', condition: '', ruleA: '', ruleB: '', explanation: '用户要求指标但未提供数字，AI 不能发明门槛。', answerMode: 'custom_only', questionId: null,
      options: [decisionOptions(['unused', 'unused'])[2]!], proposals: [] },
  ];
  result.issues = templates.flatMap(t => {
    const old = project.questions.find(q => q.question.title === t.title);
    return old && (old.status === 'resolved' || old.status === 'pending_review') ? [] : [{ ...t, questionId: old?.id ?? null }];
  });
  return result;
}
export function makeAdditionAnalysis(project: Project): Analysis {
  const result = makeAnalysis(project);
  result.resolvedQuestions = result.resolvedQuestions.filter(r => project.questions.find(q => q.id === r.questionId)?.stage === 'candidate');
  for (const item of result.items) {
    const c = project.draft.candidates.find(c => c.id === item.id)!;
    if (project.baseline!.p0Items.some(old => old.id === c.id)) {
      item.fields = { name: c.name, description: c.description, purpose: c.purpose, applicableState: c.applicableState, coreRule: c.coreRule };
      if (c.verification) item.verification = { ...c.verification, quantitativeRequirements: c.verification.quantitativeRequirements ?? [] };
      item.quantitativeSources = [];
    } else item.fields = { name: c.name, description: c.description, purpose: '用户主动控制监督。', applicableState: '正常监督和暂停监督', coreRule: c.coreRule || '用户点击暂停后停止检测和扣心，点击恢复后重新开始计时。' };
  }
  return result;
}
export function makeAdditionReviewResponse(project: Project, analysis = project.addition ? makeAdditionAnalysis(project) : makeAnalysis(project)) {
  const updateIds = additionUpdateIds(project);
  return { ...analysis, issues: analysis.issues.map(issue=>({...issue,affectedFields:issue.affectedFields??[],coveredGates:issue.coveredGates??[issue.gate]})), items: Object.fromEntries(analysis.items.map(({ id, ...item }) => [id, updateIds.includes(id) ? { mode: 'update' as const, ...item } : { mode: 'preserve' as const, gates: item.gates }])) };
}
export function makeIntegration(project: Project): import('../shared/domain.js').IntegrationAnalysis {
  const resolved = resolutions(project).filter(r => project.questions.find(q => q.id === r.questionId)?.stage === 'integration');
  const pending = project.questions.find(q => q.stage === 'integration' && q.status !== 'resolved');
  const hasAdjustment = project.addition!.assessment!.items.some(item => item.kind === 'existing_p0');
  const doll = project.name === '玩偶冲突浏览器' || pending && 'kind' in pending.question && pending.question.kind === 'conflict';
  return { summary: '完整检查新旧关系。' + (hasAdjustment ? '需要确认监督方式。' : '新增能力与旧规则兼容，旧内容原样继承。'), checkedP0Ids: project.draft.candidates.map(c => c.id), resolvedQuestions: resolved,
    issues: hasAdjustment && !resolved.length && pending?.status !== 'resolved' ? [{ kind: doll ? 'conflict' : 'clarification', gate: 'consistency', questionId: pending?.id ?? null, p0Ids: ['P0-1'],
      title: doll ? '实时监督与玩偶巡查冲突' : '确认暂停规则', question: doll ? '玩偶没有出现时，是否仍判定违规并提醒？' : '暂停时如何处理监督？',
      condition: '监督已开始、玩偶没有出现时。', ruleA: project.baseline!.p0Items[0]!.coreRule, ruleB: project.addition!.request,
      explanation: '新旧要求需要明确确认处理方式。', answerMode: 'choices', options: decisionOptions(['只在玩偶出现时判定。', '保持实时判定。'], true),
      proposals: [{ label: '巡查时判定', rule: '只有玩偶出现才判定；其余原样保留。', changes: [{ p0Id: 'P0-1', field: 'coreRule', value: doll ? '摄像头持续提供画面；只有玩偶出现时才判定违规并即时提醒，玩偶未出现时不判定、不提醒。' : '用户明确允许暂停监督，暂停时不检测，恢复时重新计时。' }] },
        { label: '保留实时判定', rule: '保持实时判断；新增只提供视觉反馈。', changes: [] }] }] : [] };
}
export function duplicateAnalysis(project: Project): Analysis {
  const result = makeAnalysis(project);
  result.issues = [
    { kind: 'clarification', gate: 'clarity', coveredGates: ['clarity'], p0Ids: ['P0-1'], title: '行为判定范围与可见依据', question: '第一版采用哪套可观察的行为判据？', explanation: '行为条件、持续时长和中断处理依赖同一个决定。', condition: '', ruleA: '', ruleB: '', answerMode: 'choices', questionId: null, proposals: [], affectedFields: [{ p0Id: 'P0-1', fields: ['description', 'coreRule'] }], options: decisionOptions(['离开座椅持续3秒；视线离开屏幕持续10秒；手持并注视手机持续3秒；条件中断后未完成计时清零。', '离开座椅持续3秒；闭眼或低头持续10秒；手持并注视手机持续3秒；条件中断后未完成计时清零。']) },
    { kind: 'clarification', gate: 'boundary', coveredGates: ['boundary'], p0Ids: ['P0-1'], title: '补充核心决定', question: '本地实时行为检测什么时候生效，遇到什么情况如何处理？', explanation: '仍依赖同一行为判据问题。', condition: '', ruleA: '', ruleB: '', answerMode: 'custom_only', questionId: null, proposals: [], affectedFields: [{ p0Id: 'P0-1', fields: ['verification'] }], options: [decisionOptions(['unused', 'unused'])[2]!] },
  ];
  return result;
}

export const fixtureProvider: Provider = {
  async assessAddition(project, signal) {
    signal.throwIfAborted(); const existing = project.addition!.request.includes('补充');
    if (project.addition!.request.includes('巡查＋结算＋抓拍')) return { items: ['玩偶巡查','结算','抓拍'].map((name,index)=>({kind: index===0?'existing_p0' as const:'new_p0' as const,name,description:name,targetP0Id:index===0?'P0-1':null,relatedP0Ids:['P0-1'],reason:'独立能力逐项确认。',question:''})) };
    return { items: [{ kind: existing ? 'existing_p0' : 'new_p0', name: '暂停监督', description: project.addition!.request, targetP0Id: existing ? 'P0-1' : null, relatedP0Ids: ['P0-1'], reason: existing ? '补充现有监督能力的规则。' : '新增一个独立的用户控制能力。', question: '' }] };
  },
  async reviewIntegration(project, signal) { signal.throwIfAborted(); return makeIntegration(project); },
  async developConcept(project, signal) { signal.throwIfAborted(); return makeConcept(project); },
  async analyze(project, signal, options) {
    signal.throwIfAborted();
    if (project.addition) {
      const provider = new TaskProvider({ catalog: async () => ({ models: [], defaultModel: '' }),
        complete: async () => JSON.stringify(makeAdditionReviewResponse(project, makeAdditionAnalysis(project))) });
      return provider.analyze(project, signal, options);
    }
    if (project.name === '重复问题隔离验证') return !project.questions.length ? duplicateAnalysis(project) : project.questions.some(q => q.merge) ? makeAnalysis(project) : { ...makeAnalysis(project), resolvedQuestions: [], issues: [] };
    const result = project.name === '方法论浏览器' ? makeMethodologyAnalysis(project) : project.name === '批量决策测试' ? makeBatchAnalysis(project) : project.intake ? makeConceptP0Analysis(project) : makeAnalysis(project, project.draft.candidates.length === 3);
    if (project.name === '玩偶冲突浏览器') result.items[0]!.fields.coreRule = '监督开启时摄像头持续输入、实时判断违规并即时提醒。';
    return result;
  }
};
export const fixtureAuth = {
  client: {}, async status() { return { status: 'connected', sharing: true, signingIn: false, profileId: 'fixture-profile', identity: { email: 'fixture@example.test' }, profiles: [] }; },
  signIn() {}, cancel() {}, async disconnect() {}, async select() {},
} as unknown as Auth;
