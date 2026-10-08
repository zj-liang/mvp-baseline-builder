import { useEffect, useRef, useState } from 'react';
import type { Baseline } from '../shared/domain';
import { baselineText } from './baseline-text';

export function BaselineCopy({ name, baseline }: { name: string; baseline: Baseline }) {
  const [message, setMessage] = useState('');
  const [fallback, setFallback] = useState(false);
  const [copying, setCopying] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (copying || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body || document.activeElement?.tagName === 'DIALOG') button.current?.focus({ preventScroll: true });
  }, [copying]);
  const text = baselineText(name, baseline);
  const copy = async () => {
    restoreFocus.current = document.activeElement === button.current;
    setCopying(true); setMessage('');
    try {
      await navigator.clipboard.writeText(text);
      setFallback(false); setMessage('Baseline ' + baseline.baselineVersion + ' 已复制，可直接粘贴给 Agent');
    } catch {
      setFallback(true); setMessage('浏览器未允许自动复制。请选中全文后按 Ctrl+C，或在手机上长按复制。');
    } finally { setCopying(false); }
  };
  return <section className="baseline-copy" aria-label="复制产品基线"><button ref={button} className="primary" disabled={copying} onClick={() => void copy()}>复制给 Agent · Baseline {baseline.baselineVersion}</button>
    <p role="status">{message}</p>{fallback && <><label className="field"><span>完整基线文本</span><textarea aria-label="完整基线文本" ref={area} rows={14} readOnly value={text} /></label><button onClick={() => { area.current?.focus(); area.current?.select(); }}>选中全文</button></>}
  </section>;
}
