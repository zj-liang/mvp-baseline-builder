import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { TaskProvider } from '../server/provider.js';
import { conceptResultSchema } from '../server/review-contract.js';
import { candidate, committed } from './addition-helpers.js';
import { parseModelJSON } from '../server/model-json.js';
import type { InferenceRequest } from '../server/provider.js';
import { confirmationText, evolutionConfirmationText, ready } from '../shared/domain.js';
import { candidateStatus, restoredView } from '../src/navigation.js';
import type { Analysis, Project } from '../shared/domain.js';
import { decisionOptions, makeAnalysis, makeAdditionReviewResponse, makeConcept } from './fixtures.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const question = (questionId: string | null = null): Analysis['issues'][number] => ({
  affectedFields: [], kind: 'clarification', gate: 'boundary', p0Ids: ['P0-1'], title: '显示范围', question: '暂停时是否显示？',
  condition: '', ruleA: '', ruleB: '', explanation: '核心状态需要明确。', proposals: [], questionId,
  answerMode: 'choices', options: decisionOptions(['仅正常监督时显示。', '正常与暂停时都显示。']),
});
function setup() { const store=new Store(':memory:');stores.push(store);const old=committed(store);const p=candidate(store,old);return {store,committed:old,candidate:store.applyIntegration(p.id,p.revision,{summary:'兼容，无需改变旧规则。',checkedP0Ids:p.draft.candidates.map(c=>c.id),issues:[],resolvedQuestions:[]})}; }
function providerFor(output: unknown) {
  const complete = vi.fn(async (_request: InferenceRequest) => typeof output === 'string' ? output : JSON.stringify(output));
  return { provider: new TaskProvider({ complete, catalog: async () => ({ models: [], defaultModel: '' }) }), complete };
}
const signal = () => new AbortController().signal;

describe('Complete addition review and question scope', () => {
  it('uses one keyed MVP contract for v1/v2, reviews preserved P0 gates and sends full context', async()=>{
    const{store,candidate}=setup(),wire=makeAdditionReviewResponse(candidate),{provider,complete}=providerFor(wire);
    expect(wire.items['P0-1']).toMatchObject({mode:'preserve'});
    const result=await provider.analyze(candidate,signal());const request=complete.mock.calls[0]![0];
    expect(request.input).toMatchObject({draft:candidate.draft,questions:candidate.questions,baseline:candidate.baseline,addition:{...candidate.addition,fieldPermissions:{'P0-1':[], 'P0-2':['name','description','purpose','applicableState','coreRule','verification']}}});
    expect((request.schema as any).properties.items.required).toEqual(['P0-1','P0-2']);expect(JSON.stringify(request.schema)).not.toContain('"oneOf"');expect(JSON.stringify(request.schema)).not.toContain('integrationDecision');
    expect(store.applyAnalysis(candidate.id,candidate.revision,result).status).toBe('Ready');expect(complete).toHaveBeenCalledOnce();
  });
  it.each(['historical_close','unknown_question','old_update','incomplete_update','missing_gate','missing_p0','unknown_p0','extra_property'] as const)('rejects %s with safe diagnostics and no retry',async failure=>{
    const{store,candidate}=setup(),wire:any=structuredClone(makeAdditionReviewResponse(candidate));
    if(failure==='historical_close') wire.resolvedQuestions=[{questionId:'old',reason:'old',evidence:[{messageId:'old',quote:'old'}]}];
    if(failure==='unknown_question') wire.issues=[question('unknown')];
    if(failure==='old_update') wire.items['P0-1']={mode:'update',...makeAnalysis(candidate).items[0],id:undefined};
    if(failure==='incomplete_update') delete wire.items['P0-2'].fields;
    if(failure==='missing_gate') delete wire.items['P0-1'].gates.consistency;
    if(failure==='missing_p0') delete wire.items['P0-2'];
    if(failure==='unknown_p0') wire.items['P0-99']=wire.items['P0-1'];
    if(failure==='extra_property') wire['synthetic-secret']='synthetic-secret';
    const{provider,complete}=providerFor(wire);await expect(provider.analyze(candidate,signal())).rejects.toMatchObject({code:'invalid_analysis',diagnostic:{stage:'baseline_review',category:'schema'}});
    expect(store.get(candidate.id)).toEqual(candidate);expect(complete).toHaveBeenCalledOnce();
  });
  it('rejects malformed JSON with a parse category and sanitized paths without raw values',async()=>{
    const{candidate}=setup();await expect(providerFor('{').provider.analyze(candidate,signal())).rejects.toMatchObject({diagnostic:{stage:'baseline_review',category:'json',paths:[]}});
    try{await providerFor({...makeAdditionReviewResponse(candidate),items:{secret:'private'}}).provider.analyze(candidate,signal());}catch(e){expect(JSON.stringify(e)).not.toContain('private');expect(JSON.stringify(e)).not.toContain('secret');}
  });

  it('restricts concept references to active concept questions and retains full history in input', async () => {
    const store = new Store(':memory:'); stores.push(store);
    let p = store.create({ conceptInput: '玩偶巡查，离席扣心。' });
    p = store.applyConcept(p.id, p.revision, makeConcept(p));
    p = store.decisions(p.id, p.revision, [{ issueId: p.questions[0]!.id, choice: 'A' }]);
    const historical = store.applyConcept(p.id, p.revision, makeConcept(p));
    const current: Project = { ...historical, questions: [...historical.questions,
      { ...historical.questions[0]!, id: 'active-concept', status: 'pending_answer', resolution: null },
      { ...historical.questions[0]!, id: 'candidate-only', stage: 'candidate', status: 'pending_review', resolution: null }] };
    const schema = conceptResultSchema(current), valid = makeConcept(current);
    valid.questions = [{ questionId: 'active-concept', answerMode: 'choices', title: '运行方式', question: '从哪里使用？', reason: '入口待明确。', options: decisionOptions(['在本机使用。', '在网页使用。']) }];
    expect(schema.safeParse(valid).success).toBe(true);
    for (const id of [historical.questions[0]!.id, 'candidate-only', 'unknown']) {
      const bad = structuredClone(valid); bad.questions[0]!.questionId = id; expect(schema.safeParse(bad).success).toBe(false);
      bad.questions = []; bad.resolvedQuestions = [{ questionId: id, reason: '历史重复关闭', evidence: [{ messageId: 'x', quote: 'x' }] }];
      expect(schema.safeParse(bad).success).toBe(false);
    }
    const noActive = providerFor(makeConcept(historical)); await noActive.provider.developConcept(historical, signal());
    expect(noActive.complete.mock.calls[0]![0].input).toMatchObject({ questions: historical.questions, conversation: historical.conversation });
  });
});

describe('Model JSON integrity', () => {
  it.each(['{"P0-1":{},"P0-1":{}}', '{"items":{"P0-1":{},"P0-\\u0031":{}}}', '{"gate":{"status":"pass","status":"conflict_detected"}}'])('rejects duplicate keys in %s', text => {
    expect(() => parseModelJSON(text)).toThrow('Duplicate model JSON key');
  });
  it('accepts nesting, escaped strings, numeric values and arrays without interpreting content as keys', () => {
    const value = { x: [{ a: 1 }, { a: 2 }], quoted: '"status":"pass", { [ }', unicode: '玩偶', decimal: 0.5, nil: null };
    expect(parseModelJSON(JSON.stringify(value))).toEqual(value);
  });
});
