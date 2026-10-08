import { useEffect, useId, useRef } from 'react';
import { focusContent } from './ui-feedback';

export function ReadonlyDialog({ version, running, onClose, returnTarget, children }: {
  version: string; running: boolean; onClose: () => void;
  returnTarget: () => HTMLElement | null; children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      focusContent(returnTarget());
    };
  }, []);
  return <dialog ref={dialog} className="baseline-dialog" aria-labelledby={id + '-title'} aria-describedby={id + '-description'} onClose={() => { if (!dialog.current?.open) onClose(); }}>
    <div className="dialog-heading"><h2 ref={heading} id={id + '-title'} tabIndex={-1}>当前有效基线 · Baseline {version}</h2><button onClick={() => dialog.current?.close()} aria-label="关闭当前有效基线">关闭</button></div>
    <p id={id + '-description'}>这是已保存的只读快照，查看和复制不会修改草稿。按 Esc 或点击关闭，返回原工作页。</p>
    <p className="notice" role="status">{running ? '当前审查继续进行；写入与连接设置保持锁定。' : '本次请求已结束；关闭面板后查看工作页结果。'}</p>
    {children}
  </dialog>;
}
