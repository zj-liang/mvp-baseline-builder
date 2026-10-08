import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { evolutionConfirmationText, proposalConfirmationText } from '../shared/domain.js';
import { makeIntegration, makeAdditionAnalysis } from './fixtures.js';
import { candidate, committed, code } from './addition-helpers.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(){const s=new Store(':memory:');stores.push(s);const old=committed(s);let p=candidate(s,old,'existing_p0');p={...p,name:'玩偶冲突浏览器'};return{s,old,p:s.applyIntegration(p.id,p.revision,makeIntegration(p))};}
describe('Dedicated new/old relationship decisions',()=>{
  it('a full-MVP answer opens only the displayed fields, not unrelated purpose or description',()=>{
    const{s,p}=setup(),relationship=p.addition!.integration!.issues[0]!;
    let current=s.decisions(p.id,p.revision,[],[{issueId:relationship.id,proposalId:relationship.proposals[0]!.id}],proposalConfirmationText);
    current=s.applyIntegration(p.id,current.revision,makeIntegration(current));
    const analysis=makeAdditionAnalysis(current);
    analysis.issues=[{...makeIntegration(p).issues[0]!,kind:'clarification',gate:'boundary',questionId:null,proposals:[],options:makeIntegration(p).issues[0]!.options.map(o=>({...o,proposalIndex:null})),affectedFields:[{p0Id:'P0-1',fields:['coreRule','verification']}]}];
    current=s.applyAnalysis(p.id,current.revision,analysis);
    current=s.decisions(p.id,current.revision,[{issueId:current.review!.issues[0]!.id,choice:'A'}]);
    expect(current.addition!.fieldPermissions!['P0-1']).toEqual(['verification','coreRule']);
    const bad=makeAdditionAnalysis(current);bad.items[0]!.fields.purpose='unauthorized purpose';
    code(()=>s.applyAnalysis(p.id,current.revision,bad),'existing_rule_protected');
    expect(s.get(p.id)).toEqual(current);
  });
  it('a later custom intention cannot reuse an older acceptance to close the relationship',()=>{
    const{s,p}=setup(),issue=p.addition!.integration!.issues[0]!;
    const accepted=s.decisions(p.id,p.revision,[],[{issueId:issue.id,proposalId:issue.proposals[0]!.id}],proposalConfirmationText);
    const custom=s.decisions(p.id,accepted.revision,[{issueId:issue.id,choice:'D',customAnswer:'我改为继续实时检测'}]);
    expect(custom.questions[0]!.acceptedProposal).toBe(false);
    const output=makeIntegration(custom);output.issues=[];output.resolvedQuestions=[{questionId:issue.id,reason:'latest intention',evidence:[{messageId:custom.conversation.at(-1)!.id,quote:'我改为继续实时检测'}]}];
    code(()=>s.applyIntegration(p.id,custom.revision,output),'proposal_confirmation_required');
    expect(s.get(p.id)).toEqual(custom);
  });
  it('rejects two accepted schemes that replace the same field differently in one batch',()=>{
    const{s,p}=setup();
    const output=makeIntegration(p);const second=structuredClone(output.issues[0]!);
    second.questionId=null;second.title='另一项冲突';second.question='采用另一规则？';second.proposals[0]!.changes[0]!.value='相反结果';output.issues.push(second);
    const asked=s.applyIntegration(p.id,p.revision,output),issues=asked.addition!.integration!.issues;
    code(()=>s.decisions(p.id,asked.revision,[],issues.map(i=>({issueId:i.id,proposalId:i.proposals[0]!.id})),proposalConfirmationText),'incompatible_decisions');
    expect(s.get(p.id)).toEqual(asked);
  });
  it('keeps old fields until explicit same-P0 conflict acceptance; replaces only confirmed fields and rebuilds verification',()=>{
    const{s,old,p}=setup(),issue=p.addition!.integration!.issues[0]!;
    expect(issue.kind).toBe('conflict');expect(issue.p0Ids).toEqual(['P0-1']);expect(issue.options.map(o=>o.key)).toEqual(['A','B','C']);expect(p.draft).toEqual(old.draft);
    code(()=>s.decisions(p.id,p.revision,[{issueId:issue.id,choice:'A'}]),'proposal_confirmation_required');
    code(()=>s.decisions(p.id,p.revision,[],[{issueId:issue.id,proposalId:issue.proposals[0]!.id}]),'proposal_confirmation_required');
    const accepted=s.decisions(p.id,p.revision,[],[{issueId:issue.id,proposalId:issue.proposals[0]!.id}],proposalConfirmationText);
    expect(accepted.draft.candidates[0]!.coreRule).toContain('只有玩偶出现');
    for(const key of ['purpose','description','name','applicableState','confirmedException','source'] as const) expect(accepted.draft.candidates[0]![key]).toBe(old.draft.candidates[0]![key]);
    expect(accepted.draft.candidates[0]!.verification).toBeNull();expect(accepted.review).toBeNull();expect(accepted.baseline).toEqual(old.baseline);
    const integrated=s.applyIntegration(p.id,accepted.revision,makeIntegration(accepted));expect(integrated.stage).toBe('candidate');
    const bad=makeAdditionAnalysis(integrated);bad.items[0]!.fields.purpose='new unintended purpose';code(()=>s.applyAnalysis(p.id,integrated.revision,bad),'existing_rule_protected');
    const reviewed=s.applyAnalysis(p.id,integrated.revision,makeAdditionAnalysis(integrated));expect(reviewed.status).toBe('Ready');
    s.preview(p.id,reviewed.revision);expect(s.commit(p.id,reviewed.revision,evolutionConfirmationText).baseline!.baselineVersion).toBe('v2');expect(s.readBaseline(p.id,'v1')).toEqual(old.baseline);
  });
  it('custom input cannot close a conflict or apply rules, and omitted/undecided questions persist',()=>{
    const{s,old,p}=setup(),issue=p.addition!.integration!.issues[0]!;
    const unsure=s.decisions(p.id,p.revision,[{issueId:issue.id,choice:'C'}]);
    const omitted=s.applyIntegration(p.id,unsure.revision,{...makeIntegration(unsure),issues:[],resolvedQuestions:[]});
    expect(omitted.stage).toBe('integration');expect(omitted.questions[0]!.status).toBe('undecided');expect(omitted.draft).toEqual(old.draft);
    const custom=s.decisions(p.id,omitted.revision,[{issueId:issue.id,choice:'D',customAnswer:'保留玩偶，只在出现时检测'}]);
    const attempt=makeIntegration(custom);attempt.issues=[];attempt.resolvedQuestions=[{questionId:issue.id,reason:'custom is intent',evidence:[{messageId:custom.conversation.at(-1)!.id,quote:'保留玩偶，只在出现时检测'}]}];
    code(()=>s.applyIntegration(p.id,custom.revision,attempt),'proposal_confirmation_required');expect(s.get(p.id)).toEqual(custom);
    const regenerated=s.applyIntegration(p.id,custom.revision,makeIntegration(custom));
    expect(regenerated.addition!.integration!.issues[0]!.proposals).toHaveLength(2);expect(regenerated.draft).toEqual(old.draft);
    code(()=>s.decisions(p.id,regenerated.revision,[],[{issueId:issue.id,proposalId:issue.proposals[0]!.id}],proposalConfirmationText),'stale_proposal');
  });
  it('rejects invalid proposal scopes and mixed batch failures atomically',()=>{
    const{s,p}=setup(),issue=p.addition!.integration!.issues[0]!;
    code(()=>s.decisions(p.id,p.revision,[{issueId:'unknown',choice:'C'}],[{issueId:issue.id,proposalId:issue.proposals[0]!.id}],proposalConfirmationText),'issue_not_found');
    expect(s.get(p.id)).toEqual(p);
    const output=makeIntegration(p);output.issues[0]!.proposals[0]!.changes[0]!.p0Id='P0-99';
    code(()=>s.applyIntegration(p.id,p.revision,output),'invalid_analysis');expect(s.get(p.id)).toEqual(p);
    const both=makeIntegration(p);both.resolvedQuestions=[{questionId:issue.id,reason:'close',evidence:[{messageId:p.conversation.at(-1)!.id,quote:'x'}]}];
    code(()=>s.applyIntegration(p.id,p.revision,both),'invalid_question_reference');
  });
  it('compatible adjustment proposals need acceptance too; selecting preserve leaves exact old verification intact',()=>{
    const s=new Store(':memory:');stores.push(s);const old=committed(s);let p=candidate(s,old,'existing_p0');p=s.applyIntegration(p.id,p.revision,makeIntegration(p));
    const issue=p.addition!.integration!.issues[0]!;expect(issue.kind).toBe('clarification');
    code(()=>s.decisions(p.id,p.revision,[{issueId:issue.id,choice:'A'}]),'proposal_confirmation_required');
    p=s.decisions(p.id,p.revision,[],[{issueId:issue.id,proposalId:issue.proposals[1]!.id}],proposalConfirmationText);
    expect(p.draft).toEqual(old.draft);p=s.applyIntegration(p.id,p.revision,makeIntegration(p));expect(p.stage).toBe('candidate');
  });
});
