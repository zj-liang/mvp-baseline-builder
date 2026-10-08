import type { Candidate, Project } from '../shared/domain';
import { gateKeys, ready, verificationProblem } from '../shared/domain';

export type View = 'concept' | 'workspace' | 'confirm' | 'baseline' | 'addition' | 'integration';
export const viewLabels: Record<View, string> = { concept: '产品设想', workspace: 'MVP 梳理', confirm: '最终确认', baseline: '产品基线', addition: '加入新功能', integration: '新旧功能确认' };
export const defaultView = (project: Project): View => project.baseline && !project.addition ? 'baseline' : project.stage === 'addition' ? 'addition' : project.stage === 'integration' ? 'integration' : project.stage === 'candidate' ? 'workspace' : 'concept';
export function restoredView(project: Project, stored: string | null, legacy: string | null): View {
  if (project.baseline && !project.addition || project.stage === 'concept' || project.stage === 'addition' || project.stage === 'integration') return defaultView(project);
  const previous = stored ?? (legacy === '0' ? 'concept' : legacy === '5' ? 'confirm' : 'workspace');
  if (previous === 'confirm' && ready(project.draft, project.revision, project.review, project.questions, project.addition)) return 'confirm';
  if (project.addition) return previous === 'baseline' ? 'baseline' : 'workspace';
  return previous === 'concept' ? 'concept' : 'workspace';
}
export function candidateStatus(project: Project, candidate: Candidate, unsaved: boolean): string {
  const review = project.review;
  if (unsaved || !review || review.ledgerVersion !== 1 || review.revision !== project.revision) return '待整理';
  if (project.addition && project.addition.phase !== 'review') return '待整理';
  const issues = project.questions.filter(q => q.stage !== 'legacy' && q.status !== 'resolved' && q.p0Ids.includes(candidate.id)).map(q => q.question);
  const gates = review.items.find(i => i.id === candidate.id)?.gates;
  if (issues.some(i => 'kind' in i && i.kind === 'conflict') || gates?.consistency.status === 'conflict_detected') return '存在冲突';
  if (!gates || issues.length || gateKeys.some(k => gates[k].status !== 'pass') ||
    !candidate.name.trim() || !candidate.description.trim() || !candidate.purpose.trim() || !candidate.applicableState.trim() || !candidate.coreRule.trim() || verificationProblem(candidate.verification)) return '需要决定';
  return '已明确';
}
