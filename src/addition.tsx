import type { Baseline, Project } from '../shared/domain';
import { TextField, VerificationSummary } from './workspace';

export function AdditionIntake({ project, value, onChange, onSave, onAnalyze, onConfirm, canAnalyze }: {
  project: Project; value: string; onChange: (value: string) => void; onSave: () => void;
  onAnalyze: () => void; onConfirm: () => void; canAnalyze: boolean;
}) {
  const addition = project.addition!, a = addition.assessment;
  const dirty = value !== addition.request;
  return <article className="card"><h2>你希望产品增加什么能力？</h2>
    <p>以当前 {addition.baseVersion} 为基础。先确认功能归属，再与全部现有功能一起检查规则和验收。</p>
    <TextField label="新功能设想" value={value} onChange={onChange} rows={5} />
    {dirty && <button disabled={!value.trim()} onClick={onSave}>保存新增设想</button>}
    <button className="primary" disabled={!canAnalyze || !value.trim()} onClick={onAnalyze}>让 AI 判断功能归属</button>
    {!canAnalyze && <p>配置 AI 连接并选择模型后继续；设想已保存在本机。</p>}
    {a && !dirty && <section className="addition-assessment" aria-label="功能归属建议"><h3>请确认完整新增清单</h3>
      <ol>{a.items.map((item, index) => <li key={index}><h4>{item.name || '需要补充意图'} · {item.kind === 'new_p0' ? '独立新 P0' : item.kind === 'existing_p0' ? '补充 ' + item.targetP0Id : '待澄清'}</h4><p>{item.description}</p><p>{item.reason}</p>
        {!!item.relatedP0Ids.length && <p>关联功能：{item.relatedP0Ids.join('、')}</p>}{item.kind === 'needs_clarification' && <p className="warning">{item.question} 请补充上方设想后重新判断。</p>}</li>)}</ol>
      <button className="primary" disabled={a.items.some(item => item.kind === 'needs_clarification')} onClick={onConfirm}>确认新增清单，审查新旧关系</button>
    </section>}
  </article>;
}

export function BaselineChanges({ previous, next }: { previous: Baseline; next: Baseline }) {
  const labels = { name: '名称', description: '功能描述', purpose: '用户意图', applicableState: '生效状态 / 条件', coreRule: '完整规则与边界', confirmedException: '已确认例外', verification: '验收要求' } as const;
  const background = { productDescription: '产品是什么', coreUserGoal: '使用场景 / 用户目标', productConcept: '核心产品设定' } as const;
  const show = (value: unknown) => typeof value === 'string' ? value || '无' : value ? JSON.stringify(value, null, 2) : '无';
  const backgroundChanges = Object.keys(background).filter(key => previous[key as keyof typeof background] !== next[key as keyof typeof background]);
  return <section className="card baseline-changes" aria-label="本次基线变更"><h2>从 {previous.baselineVersion} 到 {next.baselineVersion} 的变化</h2>
    {backgroundChanges.map(key => <details key={key} open><summary>{background[key as keyof typeof background]}</summary><p>原内容：{show(previous[key as keyof typeof background])}</p><p>新内容：{show(next[key as keyof typeof background])}</p></details>)}
    {next.p0Items.map(c => {
      const old = previous.p0Items.find(p => p.id === c.id);
      if (!old) return <p key={c.id}><strong>新增 {c.id} · {c.name}</strong>：{c.description}</p>;
      const keys = Object.keys(labels).filter(key => JSON.stringify(old[key as keyof typeof labels]) !== JSON.stringify(c[key as keyof typeof labels]));
      return keys.length ? <details key={c.id} open><summary>调整 {c.id} · {c.name}</summary>{keys.map(key => <div key={key}><h3>{labels[key as keyof typeof labels]}</h3>{key === 'verification' ? <><h4>原验收要求</h4><VerificationSummary value={old.verification} /><h4>新验收要求</h4><VerificationSummary value={c.verification} /></> : <><pre>原内容：{show(old[key as keyof typeof labels])}</pre><pre>新内容：{show(c[key as keyof typeof labels])}</pre></>}</div>)}</details> : <p key={c.id}>{c.id} · {c.name}：保持原样</p>;
    })}
    <p>以下完整预览将成为新的当前产品基线。旧快照继续保留。</p>
  </section>;
}
