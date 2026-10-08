import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAuth, windowsCredentialEncryption } from '../server/auth.js';
import { AIConnections } from '../server/ai-connections.js';
import { ChatGPTProvider } from '../server/provider.js';
import { AppError, publicError } from '../server/errors.js';
import { Store } from '../server/store.js';
import { makeAnalysis } from '../tests/fixtures.js';
import { confirmationText, evolutionConfirmationText, proposalConfirmationText } from '../shared/domain.js';
import type { DecisionBatch, Project } from '../shared/domain.js';

// Explicit invocation only. Attempts include failures and are persisted before dispatch.
// The curated starting baseline and scripted choices belong only to this isolated test project.
if (!process.argv.includes('--authorized-max-5')) throw Error('需要明确授权最多五次真实调用。');
const maximum = 5, reportPath = resolve('.cache/addition-stages-live.json');
mkdirSync(resolve('.cache/tests'), { recursive: true });
type Report = { date: string; directory: string; attempts: number; projectId?: string; options?: unknown; results: Array<Record<string, unknown>>; error?: unknown; outcome?: unknown };
const report: Report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { date: new Date().toISOString(), directory: mkdtempSync(resolve('.cache/tests/addition-stages-live-')), attempts: 0, results: [] };
if (!Number.isInteger(report.attempts) || report.attempts < 0 || report.attempts >= maximum) throw Error('本次五次调用预算已用完或记录无效。');
if (!resolve(report.directory).startsWith(resolve('.cache/tests') + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) throw Error('隔离目录不正确。');
const store = new Store(join(report.directory, 'baseline.sqlite'));
const authDir = resolve(process.env.BASELINE_DATA_DIR ?? 'data', 'auth'), auth = createAuth(authDir), provider = new ChatGPTProvider(auth.client);
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const request = '1.一个拿着枪的玩偶会随机打开门出现在屏幕上，只有玩偶出现时才检测违规，连续10秒没有违规它才离开。2.右上角增加开始自律按钮，点击后1分钟才能结算，1分钟后用户自由选择结算时间，结算后显示自律成功，三颗心扣光立即结束并显示自律失败。3.玩偶出现的检测时间内抓拍，发生违规则结算页面显示违规图片，右下角标注违规行为，最多展示3张照片。';
function seed(): Project {
  let p = store.create({ name: '隔离新旧关系验收', productDescription: '本机摄像头自律监督工具', productConcept: '开始后实时监督与提醒，三颗心耗尽失败，可查看实时摄像头画面。', coreUserGoal: '专注学习', features: ['实时违规监督与提醒', '三颗心与失败重开', '实时摄像头预览'] });
  const result = makeAnalysis(p);
  const rules = ['用户开始监督后持续识别违规并立即显示提醒，每次连续违规只判一次；违规是玩手机超过3秒、视线离开超过30秒、无人超过5秒。暂停或结束不判定，恢复后重新计时。', '开始时3颗心，每次违规事件扣1颗心，0心立即显示失败并结束；重新开始重置3颗心。', '监督开启时实时显示摄像头画面，未开始和结束时不采集；摄像头不可用则暂停且不扣心，恢复后用户主动继续。'];
  result.items.forEach((item,i) => {
    item.fields.coreRule=rules[i]!;item.fields.applicableState='用户主动开始且未暂停或结束监督。';
    item.verification={type:'Hybrid',agentProcess:'模拟开始、暂停、违规事件、心数变化和摄像头断开。',expectedAgentResult:'监督按规则判断，单次事件只扣一次，0心立即结束，暂停不扣心。',agentSideReview:'检查摄像头、判定和心数的状态连接。',humanTest:'真人入镜、玩手机、移开视线、离镜，对照界面判定和画面。',observability:'直接使用现有画面、违规提示和心数显示，无需额外工具。',expectedHumanResult:'画面实时显示，监督中违规后显示对应提醒；暂停不提醒，心数耗尽结束。',quantitativeRequirements:[]};
  });
  p=store.applyAnalysis(p.id,p.revision,result);return store.commit(p.id,p.revision,confirmationText);
}
function choices(p: Project): DecisionBatch {
  const batch: DecisionBatch={answers:[],proposalAcceptances:[],confirmation:proposalConfirmationText};
  const issues=p.stage==='integration'?p.addition!.integration!.issues:p.review!.issues;
  for(const issue of issues){
    const patrol=issue.proposals.find(prop=>/只有.{0,12}玩偶|仅.{0,12}玩偶|仅.{0,12}巡查/.test(prop.rule) && !/不采用.*只有/.test(prop.rule));
    const option=issue.options.find(o=>!o.unsure && (patrol?o.proposalIndex!==null && issue.proposals[o.proposalIndex]?.id===patrol.id:true));
    if(!option) {
      // Explicit scripted test-user answers, faithful to this sample; never applied to formal projects.
      const answer=issue.question.includes('帮助用户解决什么问题')?'希望用户能自主结束本轮自律，并明确知道成功或失败。':issue.p0Ids.includes('P0-6')&&issue.question.includes('什么时候生效')?'抓拍仅在玩偶出现且监督未暂停或结束时生效；结算页面查看已抓拍违规照片，最多3张并标注行为；结束后不继续采集。':null;
      if(!answer) throw new AppError('validation_incomplete','存在需补充的自定义决定，未编造测试答案。');
      batch.answers.push({issueId:issue.id,choice:'D',customAnswer:answer});continue;
    }
    const prop=option.proposalIndex!==null?issue.proposals[option.proposalIndex]:null;
    if(prop) batch.proposalAcceptances.push({issueId:issue.id,proposalId:prop.id});
    else batch.answers.push({issueId:issue.id,choice:option.key});
  }
  return batch;
}
try {
  delete report.error;
  const status=await auth.status();
  if(status.status!=='connected'||!status.sharing) throw Error('当前账号或 Plan Usage 不可用。');
  const state=await new AIConnections(authDir,windowsCredentialEncryption).state();
  const saved=state.preferences['chatgpt:'+String(status.profileId)]??{};
  if(saved.model && saved.model!=='gpt-6.1-sol') throw Error('当前模型不是 gpt-6.1-sol，未发起调用。');
  const options={...saved,connectionId:'chatgpt' as const,model:'gpt-6.1-sol'};report.options=options;save();
  async function call<T>(label:string,work:()=>Promise<T>):Promise<T>{
    if(report.attempts>=maximum) throw Error('已到五次调用上限。');
    const entry:Record<string,unknown>={label,attempt:++report.attempts};report.results.push(entry);save();
    const start=Date.now();console.log('REQUEST '+report.attempts+'/'+maximum+': '+label);
    try{const output=await work();entry.output=output;return output;}catch(error){entry.error=publicError(error);throw error;}finally{entry.elapsedMs=Date.now()-start;save();}
  }
  let p=report.projectId?store.get(report.projectId):seed();
  if(!report.projectId){report.projectId=p.id;save();p=store.startAddition(p.id,p.revision,request);}
  const old=store.readBaseline(p.id,'v1');
  while(report.attempts<maximum && p.stage!=='committed'){
    if(p.stage==='addition'){
      if(!p.addition!.assessment) p=store.applyAdditionAssessment(p.id,p.revision,await call('多项归属',()=>provider.assessAddition(p,AbortSignal.timeout(600000),options)));
      report.results.at(-1)!.memberCount=p.addition!.assessment!.items.length;save();
      if(p.addition!.assessment!.items.length<3) throw Error('巡查、结算、抓拍未逐项呈现，停止验收。');
      p=store.confirmAddition(p.id,p.revision);
    }else if(p.stage==='integration'){
      if(p.addition!.integration?.revision===p.revision && p.addition!.integration!.issues.length){
        const batch=choices(p);p=store.decisions(p.id,p.revision,batch.answers,batch.proposalAcceptances,batch.confirmation);
      }
      p=store.applyIntegration(p.id,p.revision,await call('新旧关系确认',()=>provider.reviewIntegration(p,AbortSignal.timeout(600000),options)));
      report.results.at(-1)!.phase=p.stage;report.results.at(-1)!.issues=p.addition!.integration!.issues;
      if(!report.results.some(r=>r.conflictObserved)) {
        const conflict=p.addition!.integration!.issues.find(i=>i.kind==='conflict');
        if(!conflict) throw Error('没有向用户呈现实时判定与巡查判定的冲突。');
        report.results.at(-1)!.conflictObserved=true;
        report.results.at(-1)!.oldContentPreserved=p.draft.candidates.filter(c=>old.p0Items.some(o=>o.id===c.id)).every(c=>{const{source:_source,...current}=c;return JSON.stringify(current)===JSON.stringify(old.p0Items.find(o=>o.id===c.id));});
        if(!report.results.at(-1)!.oldContentPreserved) throw Error('接受前改变了旧内容。');
      }
      save();
    }else if(p.stage==='candidate'){
      if(p.review?.revision===p.revision && p.review.issues.length){const batch=choices(p);p=store.decisions(p.id,p.revision,batch.answers,batch.proposalAcceptances,batch.confirmation);}
      p=store.applyAnalysis(p.id,p.revision,await call('统一完整 MVP 审查',()=>provider.analyze(p,AbortSignal.timeout(600000),options)));
      report.results.at(-1)!.status=p.status;report.results.at(-1)!.pending=p.questions.filter(q=>q.stage!=='legacy' && q.status!=='resolved');
      if(p.status==='Ready'){store.preview(p.id,p.revision);p=store.commit(p.id,p.revision,evolutionConfirmationText);}
      save();
    }else throw Error('unexpected stage');
  }
  report.outcome={stage:p.stage,status:p.status,baselineVersion:p.baseline?.baselineVersion,historicalUnchanged:JSON.stringify(store.readBaseline(p.id,'v1'))===JSON.stringify(old)};
  save();
}catch(error){report.error=publicError(error);console.error(report.error);process.exitCode=1;}
finally{save();store.close();console.log('ATTEMPTS='+report.attempts+'/'+maximum);}
