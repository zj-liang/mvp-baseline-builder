import { useEffect, useState } from 'react';

export function focusContent(target: HTMLElement | null, scroll = true) {
  if (!target) return;
  if (scroll) target.scrollIntoView({ block: 'start', behavior: 'instant' });
  target.focus({ preventScroll: true });
}

export type RunningTask = { projectId: string; label: string; startedAt: number };

export function WorkingStatus({ task, onCancel, children }: {
  task: RunningTask | null; onCancel: () => void; children?: React.ReactNode;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const update = () => setSeconds(task ? Math.floor((Date.now() - task.startedAt) / 1000) : 0);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [task?.startedAt]);
  return <div className="working operation-feedback">
    <span role="status">{task ? task.label + '…' : '正在保存或读取，请稍候…'}</span>
    {task && <><span className="elapsed">已等待 {seconds} 秒</span><button onClick={onCancel}>取消 AI 请求</button>{children}</>}
  </div>;
}
