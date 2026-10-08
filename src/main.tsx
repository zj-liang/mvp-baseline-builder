import React, { useEffect, useState, useId, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, RequestError } from './api';
import { focusContent, WorkingStatus } from './ui-feedback';
import type { RunningTask } from './ui-feedback';
import { confirmationText, evolutionConfirmationText, gateKeys, ready, verificationProblem } from '../shared/domain';
import type { Baseline, Candidate, ConceptIntake, DecisionBatch, Draft, Project, ProjectSummary, Verification, QuestionMerge } from '../shared/domain';
import { CandidateDefinition, ConceptWorkspace, DecisionCards, ProductSummary, TextField, VerificationSummary } from './workspace';
import { AIPanel } from './ai-panel';
import type { AuthState, Action } from './ai-panel';
import type { InferenceOptions } from '../shared/inference';
import { BaselineCopy } from './baseline-copy';
import { ReadonlyDialog } from './readonly-dialog';
import { candidateStatus, defaultView, restoredView, viewLabels } from './navigation';
import type { View } from './navigation';
import { AdditionIntake, BaselineChanges } from './addition';
import { version as appVersion } from '../package.json';

const gateLabels = { clarity: '行为明确 · Clarity', boundary: '核心边界 · Boundary', consistency: '直接逻辑一致 · Consistency', verifiability: '可验证 · Verifiability' };
const statusLabels = { Draft: '待整理', 'Needs Clarification': '需要决定', 'Conflict Detected': '存在冲突', 'Verification Undefined': '验收要求待明确', Ready: '可以最终确认', 'Awaiting User Confirmation': '等待最终确认', Committed: '已生成基线' };
const emptyVerification: Verification = { type: 'Agent', agentProcess: '', expectedAgentResult: '', agentSideReview: '', humanTest: '', observability: '', expectedHumanResult: '' };

function Field({ label, value, onChange, readOnly = false, rows = 3 }: { label: string; value: string; onChange?: (value: string) => void; readOnly?: boolean; rows?: number }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} name={label} autoComplete="off" rows={rows} value={value} readOnly={readOnly} onChange={event => onChange?.(event.target.value)} /></div>;
}
function VerificationFields({ value, onChange, readOnly = false }: { value: Verification | null; onChange?: (value: Verification) => void; readOnly?: boolean }) {
  if (readOnly && !value) return <p className="warning">验收要求待明确</p>;
  const v = value ?? emptyVerification;
  const update = (key: keyof Verification, next: string) => onChange?.({ ...v, [key]: next });
  return <div className="verification-fields">
    <label className="field"><span>验证方式 · Verification</span><select value={v.type} disabled={readOnly} onChange={e => update('type', e.target.value)}><option value="Agent">程序验证 · Agent</option><option value="Human">真人验证 · Human</option><option value="Hybrid">双重验证 · Hybrid</option></select></label>
    {(v.type === 'Agent' || v.type === 'Hybrid') && <><Field label="Agent 验证步骤" value={v.agentProcess} onChange={text => update('agentProcess', text)} readOnly={readOnly} /><Field label="预期 Agent 结果" value={v.expectedAgentResult} onChange={text => update('expectedAgentResult', text)} readOnly={readOnly} /></>}
    {(v.type === 'Human' || v.type === 'Hybrid') && <><Field label="Agent 可以检查什么" value={v.agentSideReview} onChange={text => update('agentSideReview', text)} readOnly={readOnly} /><Field label="人工测试步骤" value={v.humanTest} onChange={text => update('humanTest', text)} readOnly={readOnly} /><Field label="可观测要求" value={v.observability} onChange={text => update('observability', text)} readOnly={readOnly} /><Field label="预期人工结果" value={v.expectedHumanResult} onChange={text => update('expectedHumanResult', text)} readOnly={readOnly} /></>}
    {v.quantitativeRequirements?.map((q, i) => <div key={i}><strong>量化验收 · {q.metric}</strong>{(['target', 'sample'] as const).map(key => <Field key={key} label={key === 'target' ? '用户要求的门槛（空表示未定义）' : '用户要求的样本规模（空表示未定义）'} value={q[key] ?? ''} readOnly={readOnly} onChange={text => onChange?.({ ...v, quantitativeRequirements: v.quantitativeRequirements!.map((r, index) => index === i ? { ...r, [key]: text.trim() ? text : null } : r) })} />)}</div>)}
    {!readOnly && verificationProblem(value) && <p className="warning">{verificationProblem(value)}</p>}
  </div>;
}
function BaselineView({ baseline }: { baseline: Baseline }) {
  return <div className="baseline-view"><div className="summary-box"><span className="eyebrow">产品基线 · Baseline {baseline.baselineVersion}</span><h2>{baseline.productDescription}</h2><p>{baseline.coreUserGoal}</p><h3>核心产品设定</h3><p>{baseline.productConcept || '旧版本未记录产品设定'}</p>{baseline.createdAt !== '提交时生成' && <small>提交时间 · {new Date(baseline.createdAt).toLocaleString()}</small>}</div>
    {baseline.p0Items.map(c => <article className="card" key={c.id}><span className="eyebrow">{c.id}</span><h3>{c.name}</h3><dl><dt>功能如何运行</dt><dd>{c.description}</dd><dt>用户意图</dt><dd>{c.purpose}</dd><dt>生效状态 / 条件</dt><dd>{c.applicableState}</dd><dt>完整规则与边界</dt><dd>{c.coreRule}</dd><dt>已确认例外 / 冲突解决规则</dt><dd>{c.confirmedException || '无已确认例外'}</dd></dl><VerificationSummary value={c.verification} /></article>)}
  </div>;
}
function BackgroundEditor({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  return <><TextField label="产品是什么" value={draft.productDescription} onChange={productDescription => onChange({ ...draft, productDescription })} />
    <TextField label="使用场景 / 用户目标" value={draft.coreUserGoal} onChange={coreUserGoal => onChange({ ...draft, coreUserGoal })} />
    <TextField label="核心产品设定" value={draft.productConcept} onChange={productConcept => onChange({ ...draft, productConcept })} /></>;
}
function VerificationDetails({ candidate, onChange }: { candidate: Candidate; onChange: (v: Verification) => void }) {
  const [editing, setEditing] = useState(false);
  return <details className="full-definition"><summary>查看完整验收要求</summary><VerificationSummary value={candidate.verification} />
    <button onClick={() => setEditing(!editing)}>{editing ? '结束验收编辑' : '手动编辑验收要求'}</button>
    {editing && <div className="manual-editor"><VerificationFields value={candidate.verification} onChange={onChange} /></div>}
  </details>;
}
function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [intake, setIntake] = useState<ConceptIntake | null>(null);
  const [auth, setAuth] = useState<AuthState>({ status: 'loading', sharing: false, signingIn: false });
  const [inference, setInference] = useState<InferenceOptions>({ effort: 'high' });
  const [view, setView] = useState<View>('concept');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [runningTask, setRunningTask] = useState<RunningTask | null>(null);
  const [retryTask, setRetryTask] = useState<{ projectId: string; revision: number; stage: Project['stage']; inference: InferenceOptions } | null>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const initialPage = useRef(true);
  const errorPanel = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');
  const [feedback, setFeedback] = useState('');
  const [preview, setPreview] = useState<Baseline | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [start, setStart] = useState({ name: '', conceptInput: '' });
  const startNameInvalid = start.name.trim().length > 200;
  const [additionRequest, setAdditionRequest] = useState('');
  const [newFeature, setNewFeature] = useState('');
  const [adding, setAdding] = useState(false);
  const [displayedBaseline, setDisplayedBaseline] = useState<Baseline | null>(null);
  const [baselinePanel, setBaselinePanel] = useState<{ name: string; baseline: Baseline } | null>(null);
  const baselinePanelOrigin = useRef<HTMLButtonElement | null>(null);
  const conceptStage = project?.stage === 'concept';
  const unsaved = Boolean(project && (project.stage === 'addition' ? additionRequest !== project.addition?.request : conceptStage ? JSON.stringify(project.intake) !== JSON.stringify(intake) : JSON.stringify(project.draft) !== JSON.stringify(draft)));
  const temporaryInput = project ? Boolean(feedback || newFeature) : Boolean(start.name || start.conceptInput);
  const confirmLeavingInput = () => !temporaryInput || window.confirm('这里还有未提交的输入。离开后将放弃这些输入，是否继续？');
  useEffect(() => {
    if (!unsaved && !temporaryInput) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved, temporaryInput]);
  useEffect(() => { if (initialPage.current) { initialPage.current = false; return; } if (!baselinePanel) focusContent(pageHeading.current); }, [view, project?.id]);
  useEffect(() => {
    if (!error || busy) return;
    if (!baselinePanel) focusContent(errorCode === 'field_validation' ? document.querySelector<HTMLElement>('.main-content [aria-invalid="true"]') : errorPanel.current);
  }, [error, errorCode, busy]);
  const [aiStatus, setAIStatus] = useState({ ready: false, loading: true });
  const canAnalyze = aiStatus.ready;
  const reviewedReady = project?.stage === 'candidate' && ready(project.draft, project.revision, project.review, project.questions, project.addition);
  const refreshAuth = async () => setAuth(await api<AuthState>('/auth'));
  const loadProjects = async () => setProjects(await api<ProjectSummary[]>('/projects'));
  const apply = (value: Project) => {
    setProject(value); setDraft(structuredClone(value.draft)); setIntake(structuredClone(value.intake));
    setPreview(null); setPreviewRevision(null); setConfirmed(false);
    if (value.id !== project?.id) { setFeedback(''); setNewFeature(''); setAdding(false); }
    setAdditionRequest(value.addition?.request ?? ''); setDisplayedBaseline(value.baseline);
    localStorage.setItem('active-project', value.id);
    const prefix = 'decision-draft:' + value.id + ':';
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix) && key !== prefix + value.revision) localStorage.removeItem(key);
  };
  const act: Action = async work => {
    setBusy(true); setError(''); setErrorCode(''); setNotice(''); setRetryTask(null);
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作未完成。'); setErrorCode(e instanceof RequestError ? e.code : ''); }
    finally { setBusy(false); }
  };
  const restore = async (value: Project) => {
    apply(value); setView(defaultView(value));
    const next = restoredView(value, localStorage.getItem('view:' + value.id), localStorage.getItem('step:' + value.id));
    if (next === 'confirm') {
      setPreview(await api<Baseline>('/projects/' + value.id + '/preview?revision=' + value.revision));
      setPreviewRevision(value.revision);
    }
    setView(next);
  };
  useEffect(() => {
    let checkingAuth = true;
    void act(async () => {
      try { await Promise.all([refreshAuth(), loadProjects()]); } finally { checkingAuth = false; }
      const id = localStorage.getItem('active-project');
      if (id) await restore(await api<Project>('/projects/' + id));
    });
    const interval = setInterval(() => {
      if (checkingAuth) return;
      checkingAuth = true; void refreshAuth().catch(() => {}).finally(() => { checkingAuth = false; });
    }, 2000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => { if (project) localStorage.setItem('view:' + project.id, view); }, [view, project?.id]);
  const path = project ? '/projects/' + project.id : '';
  const requestAnalysis = async (value: Project, options = inference) => {
    const labels = { concept: '正在整理产品设想', addition: '正在判断新功能归属', integration: '正在审查新旧关系', candidate: '正在审查完整 MVP', committed: '正在审查完整 MVP' };
    setRunningTask({ projectId: value.id, label: labels[value.stage], startedAt: Date.now() }); setRetryTask(null);
    try {
      return await api<Project>('/projects/' + value.id + (value.stage === 'integration' ? '/integration/analyze' : value.stage === 'addition' ? '/addition/analyze' : value.stage === 'concept' ? '/concept/analyze' : '/analyze'), 'POST', { revision: value.revision, inference: options });
    } catch (e) {
      if (!(e instanceof RequestError) || !['analysis_cancelled', 'cancelled'].includes(e.code)) setRetryTask({ projectId: value.id, revision: value.revision, stage: value.stage, inference: { ...options } });
      throw e;
    } finally { setRunningTask(null); }
  };
  const analyze = async (value: Project = project!, options = inference) => {
    const result = await requestAnalysis(value, options);
    apply(result); setView(defaultView(result));
    if (value.stage === 'integration' && result.stage === 'candidate') {
      setNotice(result.addition!.integration!.summary);
      const reviewed = await requestAnalysis(result, options);
      apply(reviewed); setView(defaultView(reviewed)); return;
    }
    setNotice(result.stage === 'concept' ? 'AI 已整理你的设想。请完成必要决定，并确认产品设定与初始功能。' : '产品草案已更新，请在这里处理必要决定并查看每项功能。');
  };
  const save = async (): Promise<Project> => {
    const invalid = document.querySelector<HTMLElement>('.main-content [aria-invalid="true"]');
    if (invalid) { focusContent(invalid); throw new RequestError('请先修正标出的字段；当前输入已保留。', 'field_validation'); }
    let value: Project;
    if (project?.stage === 'addition') value = await api<Project>(path + '/addition', 'PUT', { revision: project.revision, request: additionRequest });
    else if (conceptStage) value = await api<Project>(path + '/concept', 'PUT', { revision: project!.revision, conceptInput: intake!.conceptInput, definition: intake!.definition });
    else {
      const exceptionsChanged = draft!.candidates.some(c => c.confirmedException !== project!.draft.candidates.find(p => p.id === c.id)!.confirmedException);
      if (exceptionsChanged && !window.confirm('确认把修改后的例外规则作为你的产品决定？这会使既有审查失效，需重新检查所有关联规则。')) throw new Error('未确认例外规则修改，尚未保存草稿。');
      value = await api<Project>(path + '/draft', 'PUT', { revision: project!.revision, draft, confirmExceptions: exceptionsChanged });
    }
    apply(value); setNotice('已保存，请按当前内容重新整理。'); return value;
  };
  const changeDraft = (value: Draft) => { setDraft(value); setPreview(null); setPreviewRevision(null); setConfirmed(false); setError(''); };
  const updateCandidate = (id: string, change: Partial<Candidate>) => changeDraft({ ...draft!, candidates: draft!.candidates.map(c => c.id === id ? { ...c, ...change } : c) });
  const navigate = (next: View) => void act(async () => {
    if (unsaved && next !== view) { setError('请先保存调整，或恢复已保存内容后再切换。'); return; }
    if (next === 'confirm' && project) {
      setPreview(await api<Baseline>(path + '/preview?revision=' + project.revision)); setPreviewRevision(project.revision); setConfirmed(false);
    }
    setView(next);
  });
  const create = (event: React.FormEvent) => { event.preventDefault(); void act(async () => {
    if (startNameInvalid) throw new RequestError('请先修正标出的项目名称；当前输入已保留。', 'field_validation');
    const value = await api<Project>('/projects', 'POST', start); apply(value); await loadProjects(); setView('concept');
    setStart({ name: '', conceptInput: '' });
    setNotice('产品设想已保存在本机。'); if (canAnalyze) await analyze(value);
  }); };
  const submitDecisions = (batch: DecisionBatch) => void act(async () => {
    const value = await api<Project>(path + '/decisions', 'POST', { revision: project!.revision, ...batch }); apply(value);
    if (canAnalyze) await analyze(value); else setNotice('你的决定已保存，连接后继续 AI 整理。');
  });
  const submitMerge = (merge: QuestionMerge) => void act(async () => {
    const value = await api<Project>(path + '/questions/merge', 'POST', { revision: project!.revision, ...merge }); apply(value);
    if (canAnalyze) await analyze(value); else setNotice('重复问题与本次答复已合并保存，连接后继续审查。');
  });
  const reset = () => {
    if (!confirmLeavingInput()) return;
    if (!window.confirm(conceptStage ? '保留原始设想，清空 AI 整理与回答？' : '保留初始功能来源和标识，清空当前整理、对话和审查？')) return;
    void act(async () => { const value = await api<Project>(path + '/reset', 'POST', { revision: project!.revision, confirmed: true }); setFeedback(''); setNewFeature(''); apply(value); setView(defaultView(value)); });
  };
  const questions = project?.questions.filter(q => q.stage === project.stage && q.status !== 'resolved').map(q => q.question) ?? [];
  const discardAddition = () => {
    if (!confirmLeavingInput()) return;
    if (!window.confirm('放弃本次新增草稿及其决定？当前已确认基线与历史快照会保留。')) return;
    void act(async () => { const value = await api<Project>(path + '/addition/discard', 'POST', { revision: project!.revision, confirmed: true }); setFeedback(''); setNewFeature(''); apply(value); setView('baseline'); });
  };
  const decisions = project && !unsaved ? <DecisionCards key={project.id + ':' + project.revision} project={project} questions={questions} canAnalyze={canAnalyze} onSubmit={submitDecisions} onMerge={submitMerge} /> : unsaved ? <p className="warning">先保存你的调整，再回答当前决策题。</p> : null;
  const saveActions = unsaved ? <><button className="primary" onClick={() => void act(async () => { await save(); })}>保存草稿</button><button onClick={() => { setDraft(structuredClone(project!.draft)); setNotice('已恢复保存内容。'); }}>恢复已保存内容</button></> : null;
  const navViews: View[] = project?.addition ? project.stage === 'addition' ? ['baseline', 'addition'] : project.stage === 'integration' ? ['baseline', 'integration'] : ['baseline', 'workspace', 'confirm'] : project?.baseline ? ['baseline'] : ['concept', 'workspace', 'confirm'];
  const commitConfirmation = project?.addition ? evolutionConfirmationText : confirmationText;
  return <div className="app-shell"><a className="skip-link" href="#main-content">跳到主内容</a><header><div className="brand"><span className="brand-icon" aria-hidden="true"><svg width="42" height="42" viewBox="0 0 64 64" focusable="false"><rect width="64" height="64" rx="6.5" fill="var(--accent)" /><path d="M18 19H47V33H20.5M15.5 45H47" fill="none" stroke="var(--paper)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span><div><strong>MVP Baseline Builder</strong><small>从模糊设想，到你认可的产品基线。</small></div></div><span className="local-badge">LOCAL FIRST <span>应用 · {appVersion}</span></span></header>
    <AIPanel auth={auth} act={act} refreshAuth={refreshAuth} value={inference} onChange={setInference} onStatus={setAIStatus} busy={busy} />
    <div className="workspace"><aside><div className="project-picker"><label>本地项目<select aria-label="选择本地项目" value={project?.id ?? ''} disabled={busy || unsaved} onChange={e => { const id = e.target.value; if (!confirmLeavingInput()) return; void act(async () => { await restore(await api<Project>('/projects/' + id)); }); }}><option value="" disabled>开始一个项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.committed ? ' · ' + (p.currentVersion ?? 'v1') : ' · 草稿'}</option>)}</select></label><button className="new-project" disabled={busy || unsaved} onClick={() => { if (!confirmLeavingInput()) return; setProject(null); setDraft(null); setIntake(null); setView('concept'); setPreview(null); setError(''); setNotice(''); setRetryTask(null); setFeedback(''); setNewFeature(''); setAdding(false); localStorage.removeItem('active-project'); setStart({ name: '', conceptInput: '' }); }}>＋ 新建项目</button></div>
      <nav aria-label="主流程">{navViews.map((name, index) => <button key={name} aria-current={view === name ? 'step' : undefined} className={view === name ? 'active' : ''} disabled={busy || (name === 'workspace' && project?.stage !== 'candidate') || (name === 'confirm' && (!reviewedReady || unsaved))} onClick={() => navigate(name)}>{name !== 'baseline' && <span>{String(index + 1).padStart(2, '0')}</span>}{viewLabels[name]}</button>)}</nav><p className="sidebar-note">读懂草案，集中做决定。<br />AI 整理，产品由你确定。</p></aside>
      <main id="main-content" tabIndex={-1} aria-busy={busy || aiStatus.loading}><div className="page-heading"><div><span className="eyebrow">{project?.name ?? '你的第一版产品'}</span><h1 ref={pageHeading} tabIndex={-1}>{viewLabels[view]}</h1></div>{project && <span className={'status ' + (!unsaved && (view === 'baseline' || project.status === 'Committed' || project.status === 'Ready') ? 'good' : '')}>{view === 'baseline' ? (displayedBaseline ?? project.baseline)?.baselineVersion === project.baseline?.baselineVersion ? '当前有效基线' : '历史快照' : unsaved ? '有未保存的调整' : view === 'confirm' && preview ? statusLabels['Awaiting User Confirmation'] : statusLabels[project.status]}</span>}</div>
        {error && <div ref={errorPanel} tabIndex={-1} className="error operation-feedback" role="alert">{error}<div className="error-actions">{retryTask && <button className="primary" disabled={busy || unsaved || !canAnalyze} onClick={() => void act(async () => {
          const current = await api<Project>('/projects/' + retryTask.projectId);
          if (current.id !== project?.id || current.revision !== retryTask.revision || current.stage !== retryTask.stage || (['connectionId', 'model', 'effort', 'thinking'] as const).some(k => inference[k] !== retryTask.inference[k])) throw new Error('草稿或模型设置已改变，请使用当前页面的审查入口。');
          await analyze(current, retryTask.inference);
        })}>重试本次审查</button>}<button disabled={busy} onClick={() => { if ((unsaved || temporaryInput) && !window.confirm('重新读取将恢复已保存内容，放弃未提交的输入。是否继续？')) return; void act(async () => { if (project) { await restore(await api<Project>(path)); setFeedback(''); setNewFeature(''); } await refreshAuth(); setNotice('已重新读取本地保存状态。'); }); }}>刷新保存状态</button>{errorCode.startsWith('subscription_sharing_usage_') && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage ↗</a>}</div></div>}
        {notice && <div className="notice" role="status">{notice}</div>}{busy && <WorkingStatus task={runningTask} onCancel={() => { if (runningTask) void api('/projects/' + runningTask.projectId + '/cancel', 'POST', {}).catch(() => {}); }}>{project?.baseline && <button onClick={event => { baselinePanelOrigin.current = event.currentTarget; setBaselinePanel({ name: project.name, baseline: structuredClone(project.baseline!) }); }}>查看当前有效基线</button>}</WorkingStatus>}
        <fieldset disabled={busy || aiStatus.loading} className="main-content">
        {!project && <form onSubmit={create} className="card start-form"><h2>先说说你想象中的产品</h2><p>只有一个模糊想法也可以。AI 会整理你的设想，把关键决定集中交给你。</p><TextField label="描述你想象中的产品 · Product Concept / Experience Premise" value={start.conceptInput} onChange={conceptInput => setStart({ ...start, conceptInput })} rows={4} /><p className="input-hint">用户在什么场景使用？会看到什么、做什么？产品有什么特别的设定？<br />例如：我想做一个自律监督工具，有玩偶随机巡查，离席会扣心。</p><label className="field"><span>项目名称（可选）{start.name && <small className="field-count">{start.name.trim().length} / 200 字符</small>}</span><input name="projectName" autoComplete="off" aria-label="项目名称（可选）" aria-invalid={startNameInvalid || undefined} aria-describedby={startNameInvalid ? "start-name-error" : undefined} value={start.name} onChange={e => setStart({ ...start, name: e.target.value })} placeholder="可以让 AI 帮你命名" />{startNameInvalid && <p id="start-name-error" className="field-error" role="alert">项目名称最多 200 字符（不含首尾空格）；当前输入已保留。</p>}</label><button className="primary" disabled={!start.conceptInput.trim()}>保存设想并开始 →</button><small>产品数据保存在本机；AI 分析会将当前需求发送至所选模型厂商。</small></form>}
        {conceptStage && intake && <><ConceptWorkspace value={intake} key={project!.id} onChange={setIntake} unsaved={unsaved} canAnalyze={canAnalyze} onSave={() => void act(async () => { await save(); })} onGenerate={() => void act(async () => { await analyze(unsaved ? await save() : project!); })} onConfirm={() => void act(async () => { const value = await api<Project>(path + '/concept/confirm', 'POST', { revision: project!.revision, confirmed: true }); apply(value); await loadProjects(); setView('workspace'); if (canAnalyze) await analyze(value); })} />{decisions}<button className="quiet" onClick={reset}>重置设想整理</button></>}
        {project?.stage === 'addition' && view === 'addition' && <><AdditionIntake project={project} value={additionRequest} onChange={setAdditionRequest} canAnalyze={canAnalyze}
          onSave={() => void act(async () => { await save(); })} onAnalyze={() => void act(async () => { await analyze(unsaved ? await save() : project); })}
          onConfirm={() => void act(async () => { const value = await api<Project>(path + '/addition/confirm', 'POST', { revision: project.revision, confirmed: true }); apply(value); setView(defaultView(value)); if (canAnalyze) await analyze(value); })} />
          <button className="quiet" onClick={discardAddition}>放弃本次新增</button></>}
        {(project?.stage === 'candidate' || project?.stage === 'integration') && draft && <>
          {view === 'concept' && <><article className="card"><h2>已确认的产品设想</h2><ProductSummary definition={draft} /><details><summary>调整产品背景与核心设定</summary><BackgroundEditor draft={draft} onChange={changeDraft} /></details>
            <details><summary>查看原始设想与已确认初始功能</summary><p>{project.intake?.conceptInput ?? '旧项目未记录原始设想'}</p>{draft.candidates.map(c => <p key={c.id}><strong>{c.id} · {c.name}</strong><br />{c.source}</p>)}<small>初始功能的来源与标识已保留，后续调整在 MVP 梳理中进行。</small></details></article><div className="bottom-actions"><div>{saveActions}</div><button disabled={unsaved} onClick={() => navigate('workspace')}>继续 MVP 梳理 →</button></div></>}
          {view === 'integration' && <><p className="notice">正在确认新旧关系；当前 {project.addition!.baseVersion} 继续有效。确认后，全部功能重新进入 MVP 审查。</p><article className="card" aria-label="本次新增意图"><h2>已确认的新增清单</h2>{project.addition!.members?.map(member => <p key={member.index}>{member.p0Id} · {project.addition!.assessment!.items[member.index]!.description}</p>)}<details><summary>查看新增原文</summary><pre>{project.addition!.request}</pre></details></article>{project.addition!.integration?.revision === project.revision ? <p className="notice">{project.addition!.integration.summary}</p> : <p className="intro">{questions.length ? '当前方案需要重新生成；已保存的答复和决定继续保留。' : '正在等待新旧关系审查成功生成方案；失败后可点击重试。'}</p>}{decisions}<div className="bottom-actions"><button className="primary" disabled={!canAnalyze} onClick={() => void act(() => analyze(project))}>重新审查新旧关系</button><button onClick={discardAddition}>放弃本次新增</button></div></>}
          {view === 'workspace' && <>
            {project.addition && <><div className="notice">正在审查本次新增功能；当前 {project.addition.baseVersion} 继续有效，完整确认后生成新版本。<p>{project.addition.integration?.summary}</p></div><article className="card" aria-label="本次新增意图"><h2>本次希望加入的内容</h2><p style={{ whiteSpace: 'pre-wrap' }}>{project.addition.request}</p><p>{project.addition.phase === 'review' ? '已确认功能归属与衔接方式；请继续核对当前草稿，在最终预览确认全部产品内容。' : '已确认功能归属；新旧规则如何衔接仍需明确决定，未确认的方案不会覆盖旧规则。'}</p></article></>}
            <p className="intro">阅读每项功能的草案，把需要决定的事情集中回答。规则检查和验收要求已整合到功能中。</p>
            <article className="card"><ProductSummary definition={draft} /><details><summary>调整产品背景与核心设定</summary><BackgroundEditor draft={draft} onChange={changeDraft} /></details></article>
            <div className="workspace-progress">{draft.candidates.filter(c => candidateStatus(project, c, unsaved) === '已明确').length} / {draft.candidates.length} 项功能已明确 · {questions.length} 项待决定</div>
            {draft.candidates.map(c => {
              const status = candidateStatus(project, c, unsaved);
              const related = questions.filter(i => 'p0Ids' in i && i.p0Ids.includes(c.id));
              const gates = project.review?.revision === project.revision ? project.review.items.find(i => i.id === c.id)?.gates : null;
              return <article className="card candidate-card" key={project.id + ':' + c.id}><div className="feature-heading"><div><span className="eyebrow">{c.id}</span><h3>{c.name}</h3></div><span className={'feature-status ' + (status === '已明确' ? 'pass' : status === '存在冲突' ? 'conflict' : 'warning')}>{status === '已明确' ? '✓' : status === '存在冲突' ? '✕' : '⚠'} {status}</span></div>
                <p>{c.description || 'AI 将根据你的设想整理功能描述。'}</p>
                <p className="verification-brief"><strong>验收：</strong>{c.verification ? c.verification.type === 'Agent' ? '程序检查' : c.verification.type === 'Human' ? '代码检查 + 人工实测' : '程序检查 + 人工实测' : '待明确'}</p>
                {c.confirmedException && <div className="confirmed-rule"><strong>你已接受的例外规则</strong><p>{c.confirmedException}</p></div>}
                {!!related.length && <><p className="warning">{related.length} 项{status === '存在冲突' ? '关联规则需要解决' : '内容需要你决定'}。</p><button disabled={unsaved} onClick={() => focusContent(document.getElementById('decision-' + related[0]!.id))}>处理问题</button></>}
                <CandidateDefinition candidate={c} onChange={change => updateCandidate(c.id, change)} />
                <VerificationDetails candidate={c} onChange={verification => updateCandidate(c.id, { verification })} />
                <details className="full-definition"><summary>查看审查依据</summary>{!gates || unsaved ? <p>当前内容需要重新整理，旧审查不再用于判定。</p> : gateKeys.map(k => <div className="gate-row" key={k}><span>{gateLabels[k]}</span><strong className={gates[k].status === 'pass' ? 'pass' : 'warning'}>{gates[k].status === 'pass' ? '已通过' : '待解决'}</strong><small>{gates[k].reason}</small></div>)}</details>
              </article>;
            })}
            {decisions}{!questions.length && <div className="notice">{reviewedReady && !unsaved ? '产品草案已梳理完成，可以进入最终确认。' : 'AI 尚需补全或重新检查当前草案，请继续整理。'}</div>}
            <details className="feedback-panel"><summary>告诉 AI 我想调整什么</summary><TextField label="用自己的话描述你希望调整的内容" value={feedback} onChange={setFeedback} /><p className="warning">已接受例外需要单独确认修改。首次提交后可从产品基线加入新功能；现有规则的调整请通过关联问题或手动编辑明确决定。</p><button disabled={!feedback.trim() || unsaved} onClick={() => void act(async () => { const value = await api<Project>(path + '/feedback', 'POST', { revision: project.revision, feedback }); setFeedback(''); apply(value); if (canAnalyze) await analyze(value); else setNotice('调整意图已保存，连接后继续整理。'); })}>保存调整意图{canAnalyze ? '并交给 AI' : ''}</button></details>
            <div className="bottom-actions"><div>{saveActions}<button className={!unsaved && !reviewedReady ? 'primary' : ''} disabled={!canAnalyze} onClick={() => void act(async () => { await analyze(unsaved ? await save() : project); })}>{project.review ? '让 AI 更新产品草案' : 'AI 整理产品草案'}</button>{!canAnalyze && <small>配置 AI 连接并选择模型后继续。</small>}</div><div><button className={reviewedReady && !unsaved ? 'primary' : ''} disabled={!reviewedReady || unsaved} onClick={() => navigate('confirm')}>进入最终确认 →</button><button className="quiet" onClick={project.addition ? discardAddition : reset}>{project.addition ? '放弃本次新增' : '重置草稿'}</button></div></div>
          </>}
          {view === 'confirm' && (preview ? <><p className="intro">完整检查产品设定、全部规则与验收要求。确认只对应当前预览，提交后的基线快照只读。</p>{project.addition && project.baseline && <BaselineChanges previous={project.baseline} next={preview} />}<BaselineView baseline={preview} /><div className="commit-panel"><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{commitConfirmation}</label><button className="primary" disabled={!confirmed || unsaved || previewRevision !== project.revision} onClick={() => void act(async () => { const value = await api<Project>(path + '/commit', 'POST', { revision: previewRevision, confirmation: commitConfirmation }); apply(value); await loadProjects(); setView('baseline'); setNotice('Baseline ' + value.baseline!.baselineVersion + ' 已保存在本机，可以复制给开发 Agent。'); })}>确认并生成 Baseline {preview.baselineVersion}</button><button onClick={() => navigate('workspace')}>返回 MVP 梳理</button></div></> : <div className="empty"><p>预览尚未生成或已经失效。</p><button onClick={() => navigate('workspace')}>返回 MVP 梳理</button></div>)}
        </>}
        {project?.baseline && view === 'baseline' && <>
          <div className="notice">当前有效基线：{project.baseline.baselineVersion}。正在查看{(displayedBaseline ?? project.baseline).baselineVersion === project.baseline.baselineVersion ? '当前基线' : '历史快照'}：{(displayedBaseline ?? project.baseline).baselineVersion}。所有已提交快照只读。{project.addition && <p>新增草稿：{statusLabels[project.status]}；当前 {project.baseline.baselineVersion} 继续有效。</p>}</div>
          {(project.baselineHistory?.length ?? 0) > 1 && <label className="field"><span>查看基线版本</span><select value={(displayedBaseline ?? project.baseline).baselineVersion} onChange={e => { const version = e.target.value; void act(async () => { setDisplayedBaseline(await api<Baseline>(path + '/baselines/' + version)); }); }}>{project.baselineHistory!.map(b => <option key={b.version} value={b.version}>{b.version}{b.version === project.baseline!.baselineVersion ? ' · 当前' : ' · 历史快照'}</option>)}</select></label>}
          {project.addition ? <button className="primary" onClick={() => navigate(defaultView(project))}>继续本次新增功能草稿</button> : <><button className="primary" onClick={() => setAdding(!adding)}>加入新功能</button>{adding && <form className="card" onSubmit={e => { e.preventDefault(); void act(async () => { const value = await api<Project>(path + '/addition', 'POST', { revision: project.revision, request: newFeature }); setNewFeature(''); setAdding(false); apply(value); setView('addition'); if (canAnalyze) await analyze(value); }); }}><TextField label="新功能设想" value={newFeature} onChange={setNewFeature} rows={5} /><p>从当前 {project.baseline.baselineVersion} 开始，旧基线继续有效。</p><button className="primary" disabled={!newFeature.trim()}>保存新功能并开始</button></form>}</>}
          <BaselineCopy key={project.id + ':' + (displayedBaseline ?? project.baseline).baselineVersion} name={project.name} baseline={displayedBaseline ?? project.baseline} /><BaselineView baseline={displayedBaseline ?? project.baseline} />
        </>}
        </fieldset>
      </main></div>{baselinePanel && <ReadonlyDialog version={baselinePanel.baseline.baselineVersion} running={Boolean(runningTask)} onClose={() => setBaselinePanel(null)} returnTarget={() => baselinePanelOrigin.current?.isConnected ? baselinePanelOrigin.current : pageHeading.current}><BaselineCopy name={baselinePanel.name} baseline={baselinePanel.baseline} /><BaselineView baseline={baselinePanel.baseline} /></ReadonlyDialog>}<footer>读懂草案 · 集中决定 · 整体确认 <span>产品基线可持续演化，已提交快照保留</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
