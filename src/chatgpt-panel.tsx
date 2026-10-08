import { useState } from 'react';
import { ContinueWithChatGPTButton } from '@siwc/react';
import '@siwc/react/styles.css';
import { api } from './api';
import type { AuthState, Action } from './ai-panel';

export function AuthPanel({ auth, act, refresh }: { auth: AuthState; act: Action; refresh: () => Promise<void> }) {
  const connected = auth.status === 'connected';
  const connect = (options: Record<string, unknown> = {}) => void act(async () => { await api('/auth/connect', 'POST', options); await refresh(); });
  const firstWelcome = connected && auth.sharing && !localStorage.getItem(`plan-notice:${auth.profileId}`);
  const [dismissed, setDismissed] = useState(false);
  return <section className="auth-panel" aria-label="ChatGPT 连接"><div><span className={`dot ${connected ? 'green' : ''}`} /><strong>{auth.signingIn ? '正在连接 ChatGPT' : connected ? 'Connected' : auth.status === 'reauth_required' ? '需要重新登录' : 'Connect ChatGPT'}</strong><p>{auth.identity?.email ?? '使用自己的 ChatGPT 账号，无需 API Key'}</p>{connected && <small>{auth.sharing ? 'Using ChatGPT plan · 已授权 Plan Usage' : '已登录，尚未授权 Plan Usage'}</small>}</div>
    <div className="auth-actions">{auth.signingIn ? <button onClick={() => void act(async () => { await api('/auth/cancel', 'POST', {}); await refresh(); })}>取消连接</button> : <><ContinueWithChatGPTButton onClick={() => connect()} />{connected && !auth.sharing && <button onClick={() => connect({ reconsent: true })}>启用 ChatGPT Plan Usage</button>}{connected && <button onClick={() => void act(async () => { try { await api('/auth/sign-out', 'POST', {}); } finally { await refresh(); } })}>Sign out</button>}</>}
    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage ↗</a>
    {Boolean(auth.profiles?.length) && <details><summary>ChatGPT 连接</summary><select aria-label="选择 ChatGPT 连接" value={auth.profileId ?? ''} disabled={auth.signingIn} onChange={e => void act(async () => { await api('/auth/select', 'POST', { id: e.target.value }); await refresh(); })}><option value="" disabled>选择连接</option>{auth.profiles?.filter(p => !p.pending).map(p => <option key={p.id} value={p.id}>{p.label} · {p.status}</option>)}</select><button disabled={auth.signingIn} onClick={() => connect({ newProfile: true })}>添加账号</button>{auth.profiles?.filter(p => p.pending).map(p => <button key={p.id} onClick={() => connect({ profileId: p.id })}>继续 {p.label} 授权</button>)}</details>}
    </div>
    {auth.error && <p className="error" role="alert">{auth.error.message}</p>}
    {firstWelcome && !dismissed && <div className="welcome"><p>已启用 ChatGPT Plan Usage。符合条件的 AI 请求将使用你的 ChatGPT Plan 或已授权的额度，可在 ChatGPT 设置中管理。</p><button onClick={() => { localStorage.setItem(`plan-notice:${auth.profileId}`, 'seen'); setDismissed(true); }}>知道了</button></div>}
  </section>;
}
