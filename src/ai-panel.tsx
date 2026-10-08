import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AuthPanel } from './chatgpt-panel';
import { connectionLabels, inferenceOptionsSchema } from '../shared/inference';
import type { AIState, ConnectionId, InferenceOptions, ModelCatalog, ModelInfo } from '../shared/inference';

export type AuthState = { status: string; sharing: boolean; signingIn: boolean; profileId?: string; identity?: { name?: string; email?: string }; profiles?: Array<{ id: string; label: string; status: string; pending?: boolean }>; error?: { message: string; code: string } | null };
export type Action = (work: () => Promise<void>) => Promise<void>;
const defaults = (model: ModelInfo): InferenceOptions => ({ model: model.slug, ...(model.reasoning?.defaultEffort ? { effort: model.reasoning.defaultEffort } : {}), ...(model.reasoning?.toggle ? { thinking: true } : {}) });

export function AIPanel({ auth, act, refreshAuth, value, onChange, onStatus, busy }: { auth: AuthState; act: Action; refreshAuth: () => Promise<void>; value: InferenceOptions; onChange: (v: InferenceOptions) => void; onStatus: (v: { ready: boolean; loading: boolean }) => void; busy: boolean }) {
  const [state, setState] = useState<AIState | null>(null), [id, setId] = useState<ConnectionId>('chatgpt');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [key, setKey] = useState(''), [testing, setTesting] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsId = 'ai-connection-settings';
  const sequence = useRef(0);
  const preferenceKey = (selected: ConnectionId) => selected === 'chatgpt' && auth.profileId ? 'chatgpt:' + auth.profileId : selected;
  const configured = id === 'chatgpt' ? auth.status === 'connected' && auth.sharing && !auth.signingIn : Boolean(state?.connections.find(c => c.id === id)?.configured);
  const model = catalog?.models.find(m => m.slug === value.model);
  const validParameters = Boolean(model && (!value.effort || model.reasoning?.efforts.includes(value.effort)) && (value.thinking === undefined || model.reasoning?.toggle) && !(value.thinking === false && value.effort));
  const available = Boolean(configured && model && validParameters && !loading && !error);
  useEffect(() => { onStatus({ ready: available && !testing, loading }); }, [available, testing, loading, onStatus]);
  useEffect(() => { setKey(''); }, [id]);
  const load = async (next: AIState, selected: ConnectionId, preferred?: InferenceOptions, refresh = false) => {
    const token = ++sequence.current;
    setState(next); setId(selected); setCatalog(null); setError(''); setLoading(true); onStatus({ ready: false, loading: true });
    let chosen = preferred ?? next.preferences[preferenceKey(selected)] ?? { connectionId: selected };
    if (selected === 'chatgpt' && !next.preferences[preferenceKey(selected)]) {
      try { chosen = { ...inferenceOptionsSchema.parse(JSON.parse(localStorage.getItem('inference:' + auth.profileId) ?? '{}')), connectionId: selected }; } catch { chosen = { connectionId: selected }; }
    }
    onChange({ ...chosen, connectionId: selected });
    const ready = selected === 'chatgpt' ? auth.status === 'connected' && auth.sharing && !auth.signingIn : next.connections.some(c => c.id === selected && c.configured);
    if (!ready) { setLoading(false); return; }
    try {
      const result = await api<ModelCatalog>('/models?connectionId=' + selected + (refresh ? '&refresh=1' : ''));
      if (token !== sequence.current) return;
      setCatalog(result);
      if (!chosen.model && selected === 'chatgpt' && result.defaultModel) {
        const actual = result.models.find(m => m.slug === result.defaultModel);
        chosen = { ...(actual ? defaults(actual) : {}), ...chosen, model: result.defaultModel, connectionId: selected };
        // Migrate the old automatic display to its concrete current ID once.
        next = await api<AIState>('/ai/preferences', 'PUT', chosen);
        if (token !== sequence.current) return; setState(next);
      }
      onChange({ ...chosen, connectionId: selected });
      if (chosen.model && !result.models.some(m => m.slug === chosen.model)) setError('已选模型当前不可用，请刷新目录并重新选择。');
    } catch (e) { if (token === sequence.current) setError(e instanceof Error ? e.message : '模型目录读取失败。'); }
    finally { if (token === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    if (auth.status === 'loading') return;
    let cancelled = false;
    setLoading(true); onStatus({ ready: false, loading: true });
    void api<AIState>('/ai/connections').then(next => { if (!cancelled) return load(next, next.activeConnectionId); }).catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : '连接读取失败。'); setLoading(false); } });
    return () => { cancelled = true; sequence.current++; };
  }, [auth.profileId, auth.status, auth.sharing, auth.signingIn]);
  const persist = (chosen: InferenceOptions) => void act(async () => {
    const next = await api<AIState>('/ai/preferences', 'PUT', chosen);
    setState(next); onChange(chosen); setError('');
  });
  const entry = state?.connections.find(c => c.id === id);
  const tested = entry?.status === 'verified' && entry.testedModel === value.model;
  const status = id === 'chatgpt' ? configured ? '已连接 · ChatGPT Plan Usage' : auth.signingIn ? '正在登录' : '尚未连接或授权' : !configured ? '尚未配置' : tested ? '验证成功' : entry?.status === 'failed' && entry.testedModel === value.model ? '连接失败' : '已配置 · 此模型未验证';
  const needsAttention = !available || Boolean(entry?.error && entry.testedModel === value.model);
  const showSettings = settingsExpanded || needsAttention || testing;
  return <section className={'ai-panel' + (!showSettings ? ' compact' : '')} aria-label="AI 连接"><div className="ai-heading"><div><h2>AI 连接</h2><span>{status}{available && <> · {value.model} · {value.thinking === false ? '思考关闭' : value.effort ? '思考强度 ' + value.effort : '模型默认思考'}</>}</span></div><button className="quiet" aria-controls={settingsId} aria-expanded={showSettings} disabled={needsAttention || testing} onClick={() => setSettingsExpanded(!settingsExpanded)}>{showSettings ? '收起连接设置' : '调整连接与模型'}</button></div>
    <div id={settingsId} hidden={!showSettings}>
    {loading && <p role="status">正在读取 AI 连接与模型…</p>}
    <fieldset disabled={busy || loading} className="ai-settings">
      <label>连接方式<select aria-label="连接方式" value={id} onChange={e => { const selected = e.target.value as ConnectionId; void act(async () => { const chosen = state?.preferences[preferenceKey(selected)] ?? { connectionId: selected }; const next = await api<AIState>('/ai/preferences', 'PUT', { ...chosen, connectionId: selected }); await load(next, selected, chosen); }); }}>{Object.entries(connectionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>审查模型<select aria-label="审查模型" disabled={!configured || loading || !catalog} value={value.model ?? ''} onChange={e => { const selected = catalog?.models.find(m => m.slug === e.target.value); if (selected) persist({ ...defaults(selected), connectionId: id }); }}>
        {!value.model && <option value="" disabled>{loading ? '读取模型中…' : '请选择模型'}</option>}
        {value.model && !model && <option value={value.model} disabled>{loading ? '读取模型中…' : value.model + ' · 当前不可用'}</option>}
        {catalog?.models.map(m => <option key={m.slug} value={m.slug}>{m.slug}</option>)}
      </select></label>
      {model?.reasoning?.toggle && <label>思考模式<select aria-label="思考模式" value={value.thinking === false ? 'off' : 'on'} onChange={e => persist({ ...value, thinking: e.target.value === 'on', ...(e.target.value === 'off' ? { effort: undefined } : {}) })}><option value="on">开启</option><option value="off">关闭</option></select></label>}
      {!!model?.reasoning?.efforts.length && value.thinking !== false && <label>思考强度<select aria-label="思考强度" value={value.effort ?? ''} onChange={e => persist({ ...value, effort: e.target.value as InferenceOptions['effort'] || undefined })}><option value="">模型默认</option>{model.reasoning.efforts.map(e => <option key={e} value={e}>{({ none: '不思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' })[e]} · {e}</option>)}</select></label>}
      <button disabled={!configured} onClick={() => void act(async () => { const next = await api<AIState>('/ai/connections'); await load(next, id, value, true); })}>刷新模型列表</button>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {model && !validParameters && <p className="error" role="alert">已保存的思考设置不适用于此模型，请重新选择设置。</p>}
    <details className="ai-manage"><summary>管理连接</summary><fieldset disabled={busy || loading}>
      {id === 'chatgpt' ? <AuthPanel auth={auth} act={act} refresh={refreshAuth} /> : <div className="api-key-form"><p>使用 {connectionLabels[id]} 的官方标准 API Key。保存在本机并由 Windows 加密保护。</p>
        <label className="field"><span>API Key</span><input aria-label="API Key" type="password" autoComplete="off" value={key} maxLength={4096} onChange={e => setKey(e.target.value)} placeholder={configured ? '已保存；填写新 Key 可更换' : '填写你的 API Key'} /></label>
        <div className="ai-actions"><button disabled={!key.trim()} onClick={() => { const input = key; setKey(''); void act(async () => { const next = await api<AIState>('/ai/connections/' + id + '/key', 'PUT', { key: input }); await load(next, id, value); }); }}>{configured ? '更换 Key' : '保存 Key'}</button>
          <button disabled={!configured} onClick={() => void act(async () => { setKey(''); const next = await api<AIState>('/ai/connections/' + id + '/key', 'DELETE'); await load(next, id, value); })}>移除 Key</button>
          <button disabled={!available} onClick={() => { setTesting(true); void act(async () => { try { const next = await api<AIState>('/ai/connections/' + id + '/test', 'POST', value); setState(next); } finally { setTesting(false); const next = await api<AIState>('/ai/connections'); setState(next); } }); }}>测试连接</button></div>
        <small>保存 Key 不调用模型；测试连接会调用一次所选模型，使用对应 API 额度。</small>
        {entry?.error && entry.testedModel === value.model && <p className="error">{entry.error}</p>}
      </div>}
    </fieldset></details>
    {testing && <button onClick={() => void api('/ai/test/cancel', 'POST', {})}>取消连接测试</button>}
    </div>
  </section>;
}
