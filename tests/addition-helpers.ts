import { expect } from 'vitest';
import { Store } from '../server/store.js';
import type { AdditionAnalysis, Project } from '../shared/domain.js';
import { confirmationText } from '../shared/domain.js';
import { makeAnalysis, makeAdditionAnalysis, makeIntegration } from './fixtures.js';
export const code=(fn:()=>unknown,code:string)=>expect(fn).toThrow(expect.objectContaining({code}));
export const classification=(kind: AdditionAnalysis['items'][number]['kind']='new_p0'):AdditionAnalysis=>({items:[{kind,name:'暂停监督',description:'用户主动暂停监督。',targetP0Id:kind==='existing_p0'?'P0-1':null,relatedP0Ids:['P0-1'],reason:'归属判断',question:kind==='needs_clarification'?'哪种能力？':''}]});
export function committed(s:Store) {let p=s.create({name:'扩展产品',productDescription:'监督产品',coreUserGoal:'专注',productConcept:'本机监督',features:['监督']});p=s.applyAnalysis(p.id,p.revision,makeAnalysis(p));return s.commit(p.id,p.revision,confirmationText);}
export function candidate(s:Store,p:Project,kind:AdditionAnalysis['items'][number]['kind']='new_p0'){p=s.startAddition(p.id,p.revision,'暂停监督');p=s.applyAdditionAssessment(p.id,p.revision,classification(kind));return s.confirmAddition(p.id,p.revision);}
export function checked(s:Store,p:Project){p=s.applyIntegration(p.id,p.revision,makeIntegration(p));return s.applyAnalysis(p.id,p.revision,makeAdditionAnalysis(p));}
