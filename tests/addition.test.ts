import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { Store } from '../server/store.js';
import { confirmationText, evolutionConfirmationText } from '../shared/domain.js';
import { makeAnalysis, makeAdditionAnalysis, makeIntegration } from './fixtures.js';
import { classification, committed, candidate, checked, code } from './addition-helpers.js';
const stores: Store[] = [];
const store = (path = ':memory:') => { const s = new Store(path); stores.push(s); return s; };
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch {} } });
describe('Versioned feature additions', () => {
  it('confirms a multi-item mixed list atomically and preserves stable sources before relationship review', () => {
    const s = store(), old = committed(s), p = s.startAddition(old.id, old.revision, '玩偶巡查；结算；抓拍');
    code(() => s.confirmAddition(p.id, p.revision), 'addition_incomplete');
    const assessed = s.applyAdditionAssessment(p.id, p.revision, { items: [classification('existing_p0').items[0]!, ...['结算','抓拍'].map(name => ({ ...classification().items[0]!, name, description: name }))] });
    expect(assessed.draft).toEqual(old.draft);
    const c = s.confirmAddition(p.id, assessed.revision);
    expect(c.stage).toBe('integration'); expect(c.questions).toHaveLength(0); expect(c.review).toBeNull();
    expect(c.addition!.members).toEqual([{ index: 0, p0Id: 'P0-1' }, { index: 1, p0Id: 'P0-2' }, { index: 2, p0Id: 'P0-3' }]);
    expect(c.draft.candidates[0]).toEqual(old.draft.candidates[0]);
    expect(c.draft.candidates.slice(1).map(c => c.source)).toEqual(['结算','抓拍']);
    code(() => s.applyAnalysis(c.id, c.revision, makeAdditionAnalysis(c)), 'concept_unconfirmed');
    code(() => s.startAddition(c.id, c.revision, 'another'), 'addition_unavailable');
  });
  it('compatible additions enter full MVP directly, recheck every P0, commit v2/v3 and never rewrite history', () => {
    const s = store(), old = committed(s);
    const payload = s.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(old.id)!.payload;
    let p = candidate(s, old);
    p = s.applyIntegration(p.id, p.revision, makeIntegration(p));
    expect(p.stage).toBe('candidate'); expect(p.review).toBeNull();
    code(() => s.preview(p.id, p.revision), 'gates_blocked');
    p = s.applyAnalysis(p.id, p.revision, makeAdditionAnalysis(p));
    expect(p.status).toBe('Ready'); expect(p.draft.candidates[0]).toEqual(old.draft.candidates[0]);
    expect(s.preview(p.id, p.revision).baselineVersion).toBe('v2');
    code(() => s.commit(p.id, p.revision, confirmationText), 'confirmation_required');
    const done = s.commit(p.id, p.revision, evolutionConfirmationText);
    expect(s.commit(p.id, p.revision, evolutionConfirmationText).baseline).toEqual(done.baseline);
    expect(s.readBaseline(p.id,'v1')).toEqual(old.baseline);
    expect(s.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(p.id)!.payload).toBe(payload);
    expect(() => s.db.prepare('UPDATE baseline_versions SET payload=? WHERE project_id=?').run('{}',p.id)).toThrow('immutable');
    expect(() => s.db.prepare('DELETE FROM baseline_versions WHERE project_id=?').run(p.id)).toThrow('immutable');
    code(() => s.save(p.id, done.revision, done.draft), 'read_only');
    const next = checked(s, candidate(s, done));
    expect(next.addition!.baseVersion).toBe('v2');
    expect(s.commit(p.id,next.revision,evolutionConfirmationText).baseline!.baselineVersion).toBe('v3');
    expect(JSON.stringify(done.baseline)).not.toMatch(/assessment|conversation|questions|source|members/);
  });
  it('rejects unknown references, incomplete lists and stale results without any partial writes', () => {
    const s=store(), old=committed(s), p=s.startAddition(old.id,old.revision,'暂停');
    code(() => s.applyAdditionAssessment(p.id,p.revision,{ items:[{...classification().items[0]!,relatedP0Ids:['unknown']}] }), 'invalid_analysis');
    expect(s.get(p.id)).toEqual(p);
    const changed=s.saveAdditionRequest(p.id,p.revision,'暂停按钮');
    code(() => s.applyAdditionAssessment(p.id,p.revision,classification()), 'stale_revision');
    const c=s.confirmAddition(p.id,s.applyAdditionAssessment(p.id,changed.revision,classification()).revision);
    code(() => s.applyIntegration(p.id,c.revision,{ ...makeIntegration(c),checkedP0Ids:['P0-1','P0-1'] }), 'invalid_analysis');
    expect(s.get(p.id)).toEqual(c);
    const reviewed=checked(s,c), bad=makeAdditionAnalysis(reviewed);
    bad.items[0]!.fields.purpose='unrelated rewrite';
    code(() => s.applyAnalysis(p.id,reviewed.revision,bad), 'existing_rule_protected');
    expect(s.get(p.id)).toEqual(reviewed);
  });
  it('persists relationship stage across restart and discards only this independent addition', () => {
    mkdirSync(resolve('.cache'),{recursive:true});const dir=mkdtempSync(resolve('.cache/addition-test-'));
    try {
      const path=join(dir,'db.sqlite'),first=store(path),old=committed(first),c=candidate(first,old);
      first.close();const resumed=store(path);expect(resumed.get(old.id)).toEqual(c);
      const discarded=resumed.discardAddition(c.id,c.revision);expect(discarded.draft).toEqual(old.draft);expect(discarded.baseline).toEqual(old.baseline);
      code(() => resumed.applyIntegration(c.id,c.revision,makeIntegration(c)), 'read_only');
      expect(resumed.startAddition(c.id,discarded.revision,'另一个功能').addition!.assessment).toBeNull();
      resumed.close();
    } finally { if(dirname(dir)!==resolve('.cache')) throw Error('unsafe cleanup');rmSync(dir,{recursive:true,force:true}); }
  });
  it('recovers failed legacy additions without splitting confirmed members, retiring placeholder while retaining answers', () => {
    mkdirSync(resolve('.cache'),{recursive:true});const dir=mkdtempSync(resolve('.cache/addition-test-'));
    try {
      const path=join(dir,'db.sqlite'),s=store(path),old=committed(s),c=candidate(s,old);
      const row=JSON.parse(String(s.db.prepare('SELECT payload FROM feature_additions WHERE project_id=?').get(c.id)!.payload));
      row.phase='review';row.assessment=row.assessment.items[0];row.newP0Id='P0-2';delete row.members;delete row.fieldPermissions;
      row.integrationQuestionId='legacy-placeholder';
      s.ledger.put(c.id,{ id:row.integrationQuestionId,stage:'candidate',status:'pending_review',p0Ids:['P0-1','P0-2'],gate:'consistency',createdRevision:c.revision,createdBasis:'新增功能的规则衔接需用户确认',openedAfter:null,acceptedProposal:false,resolution:null,
        question:{id:row.integrationQuestionId,questionId:row.integrationQuestionId,answerMode:'custom_only',title:'占位',question:'衔接？',reason:'占位',options:[]} });
      s.message(c.id,'user','保留玩偶');
      s.db.prepare('UPDATE feature_additions SET payload=? WHERE project_id=?').run(JSON.stringify(row),c.id);
      s.db.prepare('DELETE FROM app_migrations WHERE version=?').run('addition-stages-1');
      s.close();const upgraded=store(path),p=upgraded.get(c.id);
      expect(p.stage).toBe('integration');expect(p.draft.candidates.map(c=>c.id)).toEqual(c.draft.candidates.map(c=>c.id));
      expect(p.addition!.assessment!.items).toHaveLength(1);expect(p.questions[0]!.stage).toBe('legacy');
      expect(p.conversation.some(m=>m.content==='保留玩偶')).toBe(true);expect(p.baseline).toEqual(old.baseline);
      upgraded.close();
    } finally {if(dirname(dir)!==resolve('.cache')) throw Error('unsafe cleanup');rmSync(dir,{recursive:true,force:true});}
  });
  it('preserves legacy baseline verification without adding optional fields', () => {
    const s=store(),old=committed(s),legacy=structuredClone(old.baseline!);
    delete legacy.productConcept;delete legacy.p0Items[0]!.verification!.quantitativeRequirements;
    const other=s.create({name:'old',productDescription:'old',coreUserGoal:'old',features:['old']});
    s.db.prepare('INSERT INTO baselines VALUES(?,?,?)').run(other.id,other.revision,JSON.stringify(legacy));
    const p=checked(s,candidate(s,s.get(other.id)));
    expect(p.draft.candidates[0]!.verification).toEqual(legacy.p0Items[0]!.verification);
    expect(s.readBaseline(other.id,'v1')).toEqual(legacy);
  });
});
