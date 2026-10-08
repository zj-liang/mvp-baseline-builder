import { useEffect, useId, useRef, useState } from 'react';
import { focusContent } from './ui-feedback';
import type { Candidate, ConceptDefinition, ConceptIntake, ConceptQuestion, DecisionAnswer, DecisionBatch, Draft, Project, ReviewIssue, Verification, QuestionMerge, QuestionRecord } from '../shared/domain';
import { conceptReady, proposalConfirmationText, mergeConfirmationText, questionGates } from '../shared/domain';

export function TextField({ label, value, onChange, rows = 3, limit = 12000, trimForLimit = false }: { label: string; value: string; onChange: (value: string) => void; rows?: number; limit?: number; trimForLimit?: boolean }) {
  const id = useId();
  const length = (trimForLimit ? value.trim() : value).length;
  const invalid = length > limit;
  return <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} name={label} autoComplete="off" rows={rows} maxLength={limit === 12000 ? limit : undefined} aria-invalid={invalid || undefined} aria-describedby={invalid ? id + '-error' : undefined} value={value} onChange={e => onChange(e.target.value)} />{limit === 200 && <small>{length} / {limit} 字符{trimForLimit ? '（不含首尾空格）' : ''}</small>}{invalid && <p id={id + '-error'} className="field-error" role="alert">{label}最多 {limit} 字符；请缩短内容，当前输入已保留。</p>}</div>;
}
export function ProductSummary({ definition }: { definition: Pick<Draft, 'productDescription' | 'coreUserGoal' | 'productConcept'> }) {
  return <dl className="product-summary"><dt>产品是什么</dt><dd>{definition.productDescription || '待澄清'}</dd><dt>使用场景</dt><dd>{definition.coreUserGoal || '待澄清'}</dd><dt>核心产品设定</dt><dd>{definition.productConcept || '尚未补充核心产品设定'}</dd></dl>;
}
export function ConceptWorkspace({ value, onChange, onSave, onConfirm, onGenerate, canAnalyze, unsaved }: {
  value: ConceptIntake; onChange: (value: ConceptIntake) => void; onSave: () => void; onConfirm: () => void;
  onGenerate: () => void; canAnalyze: boolean; unsaved: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const definition = value.definition;
  const change = (next: Partial<ConceptDefinition>) => onChange({ ...value, definition: { ...definition!, ...next } });
  return <>
    <article className="card"><h2>你的产品设想</h2><TextField label="描述你想象中的产品 · Product Concept / Experience Premise" value={value.conceptInput} onChange={conceptInput => onChange({ ...value, conceptInput })} rows={5} /><small>描述用户在什么场景使用、会看到什么、做什么，以及产品有什么特别的设定。可以先写一个模糊的想法。</small></article>
    {definition ? <article className="card"><span className="eyebrow">AI 整理草案 · 尚未确认</span><h2>AI 帮你整理的产品</h2><ProductSummary definition={definition} /><h3>初始功能</h3><ol className="feature-list">{definition.features.map((f, i) => <li key={i}><strong>{f.name}</strong><p>{f.description}</p></li>)}</ol>
      <button onClick={() => setEditing(!editing)}>{editing ? '结束调整' : '调整整理结果与初始功能'}</button>
      {editing && <div className="manual-editor"><TextField label="项目名称" value={definition.name} onChange={name => change({ name })} rows={1} limit={200} trimForLimit /><TextField label="产品是什么" value={definition.productDescription} onChange={productDescription => change({ productDescription })} /><TextField label="使用场景" value={definition.coreUserGoal} onChange={coreUserGoal => change({ coreUserGoal })} /><TextField label="核心产品设定" value={definition.productConcept} onChange={productConcept => change({ productConcept })} />
        {definition.features.map((f, i) => <div className="feature-editor" key={i}><TextField label={`初始功能 ${i + 1} 名称`} value={f.name} rows={1} limit={200} trimForLimit onChange={name => change({ features: definition.features.map((item, j) => j === i ? { ...item, name } : item) })} /><TextField label={`初始功能 ${i + 1} 描述`} value={f.description} onChange={description => change({ features: definition.features.map((item, j) => j === i ? { ...item, description } : item) })} /><button className="quiet" onClick={() => { if (window.confirm('从尚未确认的初始功能清单移除这项功能？')) change({ features: definition.features.filter((_, j) => j !== i) }); }}>移除这项初始功能</button></div>)}
        <button disabled={definition.features.length >= 50} onClick={() => change({ features: [...definition.features, { name: '', description: '' }] })}>补充初始功能</button>
      </div>}
    </article> : <div className="empty"><h3>先保存设想，AI 再帮你整理</h3><p>先描述你的想法，AI 会把影响整体理解的必要问题集中交给你决定。</p></div>}
    <div className="bottom-actions"><div>{unsaved && <button onClick={onSave}>保存设想与调整</button>}<button className="primary" disabled={!canAnalyze || !value.conceptInput.trim()} onClick={onGenerate}>{definition ? '重新整理产品设想' : 'AI 整理产品设想'}</button>{!canAnalyze && <small>设想已保存在本机。配置 AI 连接并选择模型后继续。</small>}</div><button disabled={unsaved || !conceptReady(value)} onClick={onConfirm}>确认这些设定与初始功能 →</button></div>
  </>;
}

type Question = ConceptQuestion | ReviewIssue;
function savedAnswer(project: Project, record: QuestionRecord): string {
  const content = project.conversation.find(m => m.id === record.lastAnswerMessageId)?.content;
  if (!content) return '尚未回答';
  try { return JSON.parse(content).answer ?? content; } catch { return content; }
}
function QuestionMergePanel({ project, canAnalyze, onMerge }: { project: Project; canAnalyze: boolean; onMerge: (value: QuestionMerge) => void }) {
  const storageKey = 'question-merge:' + project.id + ':' + project.revision;
  const [initial] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      return { open: raw.open === true, ids: Array.isArray(raw.ids) ? raw.ids.filter((id: unknown) => typeof id === 'string').slice(0, 100) as string[] : [], primaryId: typeof raw.primaryId === 'string' ? raw.primaryId : '', choice: ['A', 'B', 'C', 'D'].includes(raw.choice) ? raw.choice as DecisionAnswer['choice'] : '' as const, customAnswer: typeof raw.customAnswer === 'string' ? raw.customAnswer.slice(0, 12000) : '' };
    } catch { return { open: false, ids: [], primaryId: '', choice: '' as const, customAnswer: '' }; }
  });
  const [open, setOpen] = useState(initial.open), [ids, setIds] = useState<string[]>(initial.ids), [primaryId, setPrimaryId] = useState(initial.primaryId);
  const [choice, setChoice] = useState<DecisionAnswer['choice'] | ''>(initial.choice), [customAnswer, setCustomAnswer] = useState(initial.customAnswer);
  useEffect(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('question-merge:' + project.id + ':') && key !== storageKey) localStorage.removeItem(key);
    localStorage.setItem(storageKey, JSON.stringify({ open, ids, primaryId, choice, customAnswer }));
  }, [storageKey, project.id, open, ids, primaryId, choice, customAnswer]);
  const eligible = project.questions.filter(q => q.stage === 'candidate' && q.status !== 'resolved' && !q.requiresAcceptance && !q.acceptedProposal && 'kind' in q.question && q.question.kind !== 'conflict' && !q.question.proposals.length);
  if (eligible.length < 2) return null;
  const selected = eligible.filter(q => ids.includes(q.id));
  const primary = selected.find(q => q.id === primaryId)?.question as ReviewIssue | undefined;
  const sameScope = selected.every(q => JSON.stringify([...q.p0Ids].sort()) === JSON.stringify([...selected[0]!.p0Ids].sort()));
  const gates = [...new Set(selected.flatMap(q => questionGates(q.question as ReviewIssue)))];
  const valid = selected.length >= 2 && sameScope && primary && !(primary.kind === 'verification' && gates.length > 1) && choice && (choice !== 'D' || customAnswer.trim().length > 0 && customAnswer.trim().length <= 12000);
  const fields = [...new Set(selected.flatMap(q => (q.question as ReviewIssue).affectedFields?.flatMap(s => s.fields) ?? []))];
  const resetAnswer = () => { setChoice(''); setCustomAnswer(''); };
  return <><button className="quiet" onClick={() => setOpen(!open)}>{open ? '取消合并' : '合并重复问题'}</button>{open && <section className="card" aria-label="合并重复问题">
    <h3>把同一个业务决定合并为一题</h3><p>请选择关联相同功能的重复问题，保留一个主问题，并重新确认本次答案。原问题和历史答复都会保留，合并后仍需 AI 审查。</p>
    <fieldset className="decision-options"><legend>选择要合并的问题</legend>{eligible.map(q => <label className="decision-option" key={q.id}><input type="checkbox" checked={ids.includes(q.id)} onChange={e => { setIds(e.target.checked ? [...ids, q.id] : ids.filter(id => id !== q.id)); setPrimaryId(''); resetAnswer(); }} /><span><strong>{q.question.title}</strong><span>{q.question.question}</span><small>已保存答复：{savedAnswer(project, q)}</small></span></label>)}</fieldset>
    {!!selected.length && <label className="field"><span>保留为主问题</span><select value={primaryId} onChange={e => { setPrimaryId(e.target.value); resetAnswer(); }}><option value="">请选择主问题</option>{selected.map(q => <option key={q.id} value={q.id}>{q.question.title}</option>)}</select></label>}
    {!sameScope && <p className="warning">所选问题关联不同功能，请分别处理。</p>}
    {primary && <><fieldset className="decision-options"><legend>重新确认本次采用的答复</legend>{primary.options.map(o => <label className={`decision-option ${choice === o.key ? 'selected' : ''}`} key={o.key}><input type="radio" name={'merge-answer:' + project.id} checked={choice === o.key} onChange={() => setChoice(o.key)} /><span><strong>{o.key} · {o.label}</strong><span>{o.answer}</span><small>{o.impact}</small></span></label>)}<label className={`decision-option ${choice === 'D' ? 'selected' : ''}`}><input type="radio" name={'merge-answer:' + project.id} checked={choice === 'D'} onChange={() => setChoice('D')} /><span><strong>D · 自定义</strong><small>用自己的话表达统一后的决定。</small></span></label></fieldset>{choice === 'D' && <TextField label="合并后的自定义答复" value={customAnswer} onChange={setCustomAnswer} />}
      {!!fields.length && <p className="intro">确定答复后允许整理：{fields.map(f => decisionFieldLabels[f]).join('、')}。</p>}
      {primary.kind === 'verification' && gates.length > 1 && <p className="warning">请选择普通澄清作为主问题，单独验证问题不能覆盖其他审查内容。</p>}
    </>}
    <p>{canAnalyze ? '确认后保存合并和本次答复，再由 AI 继续审查。' : '确认后保存到本机，连接后继续审查。'}选择暂不确定会继续保留待决定。</p>
    <button className="primary" disabled={!valid} onClick={() => onMerge({ questionIds: ids, primaryQuestionId: primaryId, answer: { issueId: primaryId, choice: choice as DecisionAnswer['choice'], ...(choice === 'D' ? { customAnswer } : {}) }, confirmation: mergeConfirmationText })}>{mergeConfirmationText}</button>
  </section>}</>;
}
const decisionFieldLabels = { name: '名称', description: '描述', purpose: '用户意图', applicableState: '生效条件', coreRule: '规则与边界', confirmedException: '已确认例外', verification: '验收要求' };
function ProposalChanges({ project, proposal, p0Ids }: { project: Project; proposal: { rule: string; changes?: Array<{ p0Id: string; field: Exclude<keyof typeof decisionFieldLabels, 'verification'>; value: string }> }; p0Ids: string[] }) {
  const changes = proposal.changes ?? p0Ids.map(p0Id => ({ p0Id, field: 'confirmedException' as const, value: [project.draft.candidates.find(c => c.id === p0Id)?.confirmedException, proposal.rule].filter(Boolean).join('\n') }));
  if (!changes.length) return <p>此方案不改变现有字段，原规则保留。</p>;
  return <>{changes.map((change, index) => {
    const candidate = project.draft.candidates.find(c => c.id === change.p0Id);
    const oldValue = candidate?.[change.field];
    return <div className="proposal-change" key={index}><strong>{candidate?.name ?? '关联功能'} · {change.p0Id} · {decisionFieldLabels[change.field]}</strong><dl><dt>当前内容</dt><dd>{oldValue || (change.field === 'confirmedException' ? '无已确认例外' : '尚未填写')}</dd><dt>接受后的内容</dt><dd>{change.value}</dd></dl></div>;
  })}</>;
}
type Selection = { choice: DecisionAnswer['choice']; customAnswer?: string; proposalId?: string };
export function DecisionCards({ project, questions, canAnalyze, onSubmit, onMerge }: {
  project: Project; questions: Question[]; canAnalyze: boolean;
  onSubmit: (batch: DecisionBatch) => void; onMerge?: (value: QuestionMerge) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const wasReviewing = useRef(false);
  const reviewOrigin = useRef<HTMLButtonElement | null>(null);
  const enterReview = (button: HTMLButtonElement) => { reviewOrigin.current = button; setReviewing(true); };
  useEffect(() => {
    if (reviewing) focusContent(summaryHeading.current);
    else if (wasReviewing.current) focusContent(reviewOrigin.current?.isConnected ? reviewOrigin.current : reviewButton.current);
    wasReviewing.current = reviewing;
  }, [reviewing]);
  const key = `decision-draft:${project.id}:${project.revision}`;
  const [selections, setSelections] = useState<Record<string, Selection>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
      const valid: Record<string, Selection> = {};
      for (const question of questions) {
        const s = raw?.[question.id];
        if (s && ['A', 'B', 'C', 'D'].includes(s.choice) && (s.customAnswer === undefined || typeof s.customAnswer === 'string')) {
          valid[question.id] = { choice: s.choice, ...(s.customAnswer === undefined ? {} : { customAnswer: s.customAnswer.slice(0, 12000) }),
            ...('proposals' in question && question.proposals.some(p => p.id === s.proposalId) ? { proposalId: s.proposalId } : {}) };
        }
      }
      return valid;
    } catch { return {}; }
  });
  const select = (id: string, selection: Selection) => {
    const next = { ...selections, [id]: selection }; setSelections(next); setReviewing(false); localStorage.setItem(key, JSON.stringify(next));
  };
  const chosen = questions.flatMap(issue => {
    const selected = selections[issue.id];
    if (!selected || (selected.choice === 'D' && !selected.customAnswer?.trim())) return [];
    const option = issue.options.find(o => o.key === selected.choice);
    const proposal = 'proposals' in issue && (issue.kind === 'conflict' || project.stage === 'integration') && selected.choice !== 'D' && !option?.unsure ?
      issue.proposals.find(p => p.id === selected.proposalId) ?? (option?.proposalIndex != null ? issue.proposals[option.proposalIndex] : undefined) : undefined;
    const answer = selected.choice === 'D' ? selected.customAnswer!.trim() : option?.answer;
    if (!answer && !proposal) return [];
    return [{ issue, selected, proposal, answer }];
  });
  const batch: DecisionBatch = {
    answers: chosen.filter(c => !c.proposal).map(c => ({ issueId: c.issue.id, choice: c.selected.choice, ...(c.selected.choice === 'D' ? { customAnswer: c.answer } : {}) })),
    proposalAcceptances: chosen.filter(c => c.proposal).map(c => ({ issueId: c.issue.id, proposalId: c.proposal!.id })),
    ...(chosen.some(c => c.proposal) ? { confirmation: proposalConfirmationText } : {}),
  };
  const groups = new Map<string, { title: string; questions: Question[] }>();
  for (const question of questions) {
    const ids = 'p0Ids' in question ? project.draft.candidates.filter(c => question.p0Ids.includes(c.id)).map(c => c.id) : [];
    const groupKey = ids.join('|') || 'concept';
    const title = ids.length ? '关于：' + ids.map(id => project.draft.candidates.find(c => c.id === id)!.name).join('与') : '产品整体设想';
    if (!groups.has(groupKey)) groups.set(groupKey, { title, questions: [] });
    groups.get(groupKey)!.questions.push(question);
  }
  const closed = project.questions.filter(q => q.status === 'resolved' && q.resolution);
  const merged = project.questions.filter(q => q.merge);
  return <section className="issues" aria-label="集中决策区">{closed.length > 0 && <details className="full-definition"><summary>查看已解决问题与依据（{closed.length}）</summary>{closed.map(q => <article key={q.id}><strong>{q.question.title}</strong><p>{q.resolution!.reason}</p>{q.resolution!.evidence.map((e, i) => <blockquote key={i}>{e.quote}</blockquote>)}<small>以上是 AI 的关闭判断与用户资料引用，引用真实不代表语义已由程序证明。</small></article>)}</details>}
    {!!merged.length && <details className="full-definition"><summary>查看已合并问题与历史答复（{merged.length}）</summary>{merged.map(q => <article key={q.id}><strong>{q.question.title}</strong><p>{q.question.question}</p><blockquote>{savedAnswer(project, q)}</blockquote><small>已由你明确确认合并到「{project.questions.find(p => p.id === q.merge!.targetQuestionId)?.question.title}」。历史答复保留，合并不代表审查通过。</small></article>)}</details>}
    {questions.length > 0 && <><h2>{project.stage === 'concept' ? '确认前需要澄清的设想' : '需要你决定的事情'}</h2>
    {project.stage === 'concept' && <p className="intro">这些问题用于明确产品整体设定。完成后，再确认设定与初始功能，进入 MVP 梳理和完整审查。</p>}
    <p className="intro">共 {questions.length} 项必要决定。可以集中选择后一次确认，也可以先回答已想清楚的部分。选择后先查看汇总，AI 会统一更新草案。</p>
    {project.stage === 'candidate' && onMerge && <QuestionMergePanel project={project} canAnalyze={canAnalyze} onMerge={onMerge} />}
    <nav className="decision-index" aria-label="问题目录">
      <p>已选择 {chosen.length} 项 · 待选择 {questions.length - chosen.length} 项。已选择不代表已解决，仍需明确确认并审查。</p>
      <div>{questions.map((issue, index) => <button key={issue.id} onClick={() => focusContent(document.getElementById('decision-' + issue.id))}>{index + 1}. {issue.title}{chosen.some(c => c.issue.id === issue.id) ? ' · 已选择' : ' · 待选择'}</button>)}</div>
      <button disabled={!chosen.length} onClick={e => enterReview(e.currentTarget)}>前往决定汇总（{chosen.length} 项）</button>
      {questions.some(issue => !chosen.some(c => c.issue.id === issue.id)) && <button onClick={() => focusContent(document.getElementById('decision-' + questions.find(issue => !chosen.some(c => c.issue.id === issue.id))!.id))}>前往下一项待选择</button>}
    </nav>
    {[...groups.entries()].map(([groupKey, group]) => <section key={groupKey} className="decision-group"><h3>{group.title}</h3>{group.questions.map(issue => {
      const selected = selections[issue.id];
      const conflict = 'kind' in issue && issue.kind === 'conflict';
      const option = issue.options.find(o => o.key === selected?.choice);
      const proposal = 'proposals' in issue && (conflict || project.stage === 'integration') ? issue.proposals.find(p => p.id === selected?.proposalId) ?? (option?.proposalIndex != null ? issue.proposals[option.proposalIndex] : null) : null;
      return <article id={'decision-' + issue.id} tabIndex={-1} className={`card issue ${'kind' in issue ? issue.kind : 'clarification'}`} key={issue.id}>
        {'p0Ids' in issue && <span className="eyebrow">{issue.p0Ids.join(' ↔ ')} · {conflict ? '存在冲突' : '需要你的决定'}</span>}
        <h3>{issue.title}</h3>{conflict && <dl><dt>共同条件 / 状态</dt><dd>{issue.condition}</dd><dt>双方规则 · A</dt><dd>{issue.ruleA}</dd><dt>双方规则 · B</dt><dd>{issue.ruleB}</dd></dl>}
        {!conflict && project.stage === 'integration' && 'ruleA' in issue && issue.ruleA && <dl><dt>现有规则</dt><dd>{issue.ruleA}</dd><dt>本次新增意图</dt><dd>{issue.ruleB}</dd></dl>}
        <p className="question-reason">为什么需要决定：{'reason' in issue ? issue.reason : issue.explanation}</p>
        {project.questions.find(q => q.id === issue.id)?.status === 'pending_review' && <p className="notice">答复已保存，等待 AI 审查是否足以解决；可以继续整理或修改回答。</p>}
        {issue.answerMode === 'custom_only' && <p className="intro">{('kind' in issue && issue.kind === 'conflict' || project.questions.find(q => q.id === issue.id)?.requiresAcceptance) ? '具体方案尚未生成或已随修改失效，请重新审查生成方案；也可补充希望采用的方式，再明确接受整理后的规则。' : '这里需要补充信息：' + ('reason' in issue ? issue.reason : issue.explanation) + '。请用自己的话回答，或选择暂不确定。'}</p>}
        <fieldset className="decision-options"><legend>{issue.question}</legend>
          {issue.options.map(o => <label className={`decision-option ${selected?.choice === o.key ? 'selected' : ''}`} key={o.key}><input type="radio" name={`question:${issue.id}`} checked={selected?.choice === o.key} onChange={() => select(issue.id, { choice: o.key })} /><span><strong>{o.key} · {o.label}</strong><span>{o.answer}</span><small>{o.impact}</small></span></label>)}
          <label className={`decision-option ${selected?.choice === 'D' ? 'selected' : ''}`}><input type="radio" name={`question:${issue.id}`} checked={selected?.choice === 'D'} onChange={() => select(issue.id, { choice: 'D', customAnswer: selections[issue.id]?.customAnswer ?? '' })} /><span><strong>D · 自定义</strong><small>用自己的话表达你希望怎样运行。</small></span></label>
        </fieldset>
        {selected?.choice === 'D' && <TextField label={issue.question} value={selected.customAnswer ?? ''} onChange={customAnswer => select(issue.id, { choice: 'D', customAnswer })} />}
        {!issue.options.length && <small>旧审查尚无选择题，请使用 D 自定义或重新整理生成选项。</small>}
        {proposal && <div className="proposal"><strong>待接受的解决规则 · {proposal.label}</strong><p>{proposal.rule}</p><ProposalChanges project={project} proposal={proposal} p0Ids={'p0Ids' in issue ? issue.p0Ids : []} /><small>将在提交汇总中由你明确接受；当前尚未生效。</small></div>}
        {conflict && !issue.options.length && issue.proposals.map(p => <div className="proposal" key={p.id}><p>{p.rule}</p><button aria-pressed={selected?.proposalId === p.id} onClick={() => select(issue.id, { choice: 'A', proposalId: p.id })}>选择解决规则 · {p.label}</button></div>)}
      </article>;
    })}</section>)}
    {!reviewing ? <button ref={reviewButton} className="primary" disabled={!chosen.length} onClick={e => enterReview(e.currentTarget)}>查看所选决定（{chosen.length} 项）</button> :
      <section className="decision-confirmation card" aria-label="决定确认汇总"><h3 ref={summaryHeading} tabIndex={-1}>提交前请确认</h3><p>本次提交 {chosen.length} 项决定，另有 {questions.length - chosen.length} 项未提交。保存后旧审查失效，未提交的暂存选择随修订号变化清除。</p>
        {chosen.map(c => <div className="chosen-decision" key={c.issue.id}><strong>{c.issue.title}</strong>{'p0Ids' in c.issue && <small>关联功能：{c.issue.p0Ids.map(id => id + ' · ' + (project.draft.candidates.find(p => p.id === id)?.name ?? '关联功能')).join('、')}</small>}<p>{c.answer}</p>{'affectedFields' in c.issue && c.issue.affectedFields?.map(scope => <small key={scope.p0Id}>允许整理 {scope.p0Id}：{scope.fields.map(field => decisionFieldLabels[field]).join('、')}</small>)}{c.proposal && <div className="proposal"><strong>将明确接受：{c.proposal.label}</strong><p>{c.proposal.rule}</p><ProposalChanges project={project} proposal={c.proposal} p0Ids={'p0Ids' in c.issue ? c.issue.p0Ids : []} /></div>}</div>)}
        <p>{canAnalyze ? '确认后统一保存，并由 AI 继续当前审查。' : '确认后保存到本机，连接后继续 AI 整理。'}</p>
        <button className="primary" onClick={() => onSubmit(batch)}>{batch.proposalAcceptances.length ? proposalConfirmationText : '确认所选决定'}</button><button onClick={() => setReviewing(false)}>返回调整选择</button>
      </section>}</>}
  </section>;
}

export function VerificationSummary({ value }: { value: Verification | null }) {
  if (!value) return <p className="warning">AI 尚需明确怎样验证此功能，请回答必要问题后继续。</p>;
  return <div className="verification-summary"><p><strong>验证方式：</strong>{value.type === 'Agent' ? '由 Agent 验证逻辑' : value.type === 'Human' ? 'Agent 检查代码，真人验证体验' : 'Agent 验证逻辑，并由真人验证体验'}</p>
    {(value.type === 'Agent' || value.type === 'Hybrid') && <><p>{value.agentProcess}</p><p><strong>预期结果：</strong>{value.expectedAgentResult}</p></>}
    {(value.type === 'Human' || value.type === 'Hybrid') && <><p><strong>代码检查：</strong>{value.agentSideReview}</p><p><strong>真人测试：</strong>{value.humanTest}</p><p><strong>可观察到什么：</strong>{value.observability}</p><p><strong>预期体验：</strong>{value.expectedHumanResult}</p></>}
    {value.quantitativeRequirements?.map((q, i) => <dl key={i}><dt>用户要求的量化验收 · {q.metric}</dt><dd>门槛：{q.target ?? '未定义'}；样本要求：{q.sample ?? '未定义'}</dd></dl>)}
  </div>;
}
export function CandidateDefinition({ candidate: c, onChange }: { candidate: Candidate; onChange: (change: Partial<Candidate>) => void }) {
  const [editing, setEditing] = useState(false);
  return <details className="full-definition"><summary>查看完整定义</summary>
    <dl><dt>功能描述</dt><dd>{c.description || '待澄清'}</dd><dt>用户意图</dt><dd>{c.purpose || '待澄清'}</dd><dt>生效状态 / 条件</dt><dd>{c.applicableState || '待澄清'}</dd><dt>完整规则与边界</dt><dd>{c.coreRule || '待澄清'}</dd><dt>已确认例外</dt><dd>{c.confirmedException || '无已确认例外'}</dd><dt>原始输入</dt><dd>{c.source}</dd></dl>
    <button onClick={() => setEditing(!editing)}>{editing ? '结束手动编辑' : '手动编辑'}</button>
    {editing && <div className="manual-editor"><TextField label={`${c.id} 功能名称 · Name`} value={c.name} onChange={name => onChange({ name })} rows={1} limit={200} /><TextField label="希望实现什么 · Description" value={c.description} onChange={description => onChange({ description })} /><TextField label="用户为什么想要它 · Purpose" value={c.purpose} onChange={purpose => onChange({ purpose })} /><TextField label="生效状态或条件 · Applicable State" value={c.applicableState} onChange={applicableState => onChange({ applicableState })} /><TextField label="触发、行为、阈值与边界 · Core Rule" value={c.coreRule} onChange={coreRule => onChange({ coreRule })} />
      {c.confirmedException && <TextField label={`${c.id} 已确认例外规则`} value={c.confirmedException} onChange={confirmedException => onChange({ confirmedException })} />}
    </div>}
  </details>;
}
