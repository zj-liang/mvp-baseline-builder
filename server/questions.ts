import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConceptQuestion, Project, QuestionRecord, ReviewIssue } from '../shared/domain.js';
import { resolutionSchema, undecidedAnswer, questionGates } from '../shared/domain.js';
import type { z } from 'zod';
import { AppError } from './errors.js';
import { userEvidence } from './evidence.js';

type Question = ConceptQuestion | ReviewIssue;
export function resolutionConstraints(project: Project, stage: QuestionRecord['stage']) {
  return project.questions.filter(q => q.stage === stage && q.status !== 'resolved').map(q => {
    const opened = project.conversation.findIndex(m => m.id === q.openedAfter);
    const latest = project.conversation.findIndex(m => m.id === q.lastAnswerMessageId);
    const allowedEvidenceMessageIds = project.conversation.filter((m, index) => {
      if (m.role !== 'user' || index <= opened || index < latest || /"undecided":true/.test(m.content)) return false;
      try { const body = JSON.parse(m.content); if (typeof body.answer === 'string' && undecidedAnswer(body.answer)) return false; } catch {}
      return !undecidedAnswer(m.content);
    }).map(m => m.id);
    return { questionId: q.id, openedAfter: q.openedAfter, latestAnswerMessageId: q.lastAnswerMessageId ?? null, allowedEvidenceMessageIds };
  });
}
export class QuestionLedger {
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS question_ledger(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,id));');
  }
  list(id: string): QuestionRecord[] {
    return this.db.prepare('SELECT payload FROM question_ledger WHERE project_id=? ORDER BY rowid').all(id).map(r => JSON.parse(String(r.payload)));
  }
  put(projectId: string, record: QuestionRecord) {
    this.db.prepare('INSERT INTO question_ledger VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET payload=excluded.payload').run(projectId, record.id, JSON.stringify(record));
  }
  clear(id: string) { this.db.prepare('DELETE FROM question_ledger WHERE project_id=?').run(id); }
  register(project: Project, stage: QuestionRecord['stage'], question: Question, basis = 'AI 提出的必要业务决定', createdRevision = project.revision + 1): QuestionRecord {
    const records = this.list(project.id);
    const reference = question.questionId;
    const old = reference ? records.find(q => q.id === reference && q.stage === stage && q.status !== 'resolved') :
      records.find(q => q.stage === stage && q.status !== 'resolved' && q.question.question === question.question && q.question.title === question.title &&
        JSON.stringify(q.p0Ids) === JSON.stringify('p0Ids' in question ? question.p0Ids : []));
    if (reference && !old) throw new AppError('invalid_question_reference', 'AI 引用了未知或已解决问题。', 502);
    if (old && 'p0Ids' in question && (JSON.stringify([...old.p0Ids].sort()) !== JSON.stringify([...question.p0Ids].sort()) || old.gate !== question.gate)) throw new AppError('invalid_question_reference', '已有问题的关联功能或 Gate 不能被静默替换。', 502);
    if (old && ('kind' in old.question && old.question.kind === 'conflict') && (!('kind' in question) || question.kind !== 'conflict')) {
      throw new AppError('invalid_question_reference', '未接受的冲突不能改成普通问题。', 502);
    }
    // Coverage already confirmed during consolidation must not disappear on rewording.
    if (old && stage === 'candidate' && 'gate' in question && 'gate' in old.question) {
      question = { ...question, coveredGates: [...new Set([...questionGates(old.question), ...questionGates(question)])] };
      if (question.kind !== 'clarification' && question.coveredGates!.length > 1) throw new AppError('invalid_question_reference', '已有问题覆盖多项审查，不能改成单独的冲突或验证问题。', 502);
    }
    const id = old?.id ?? randomUUID();
    const requiresAcceptance = stage === 'integration' && 'proposals' in question && question.proposals.length > 0;
    const record: QuestionRecord = old ? { ...old, requiresAcceptance: old.requiresAcceptance || requiresAcceptance, question: { ...question, id, questionId: id } } : {
      id, stage, status: 'pending_answer', p0Ids: 'p0Ids' in question ? question.p0Ids : [],
      gate: 'gate' in question ? question.gate : 'clarity', createdRevision,
      createdBasis: basis, openedAfter: project.conversation.filter(m => m.role === 'user').at(-1)?.id ?? null,
      question: { ...question, id, questionId: id }, requiresAcceptance, acceptedProposal: false, resolution: null,
    };
    this.put(project.id, record); return record;
  }
  answer(projectId: string, id: string, undecided: boolean, accepted = false, messageId?: string) {
    const record = this.list(projectId).find(q => q.id === id)!;
    this.put(projectId, { ...record, status: undecided ? 'undecided' : 'pending_review', acceptedProposal: accepted, resolution: null, ...(messageId ? { lastAnswerMessageId: messageId } : {}) });
  }
  resolve(project: Project, stage: QuestionRecord['stage'], resolutions: z.infer<typeof resolutionSchema>[], returned: Array<{ questionId: string | null }>) {
    if (new Set(resolutions.map(r => r.questionId)).size !== resolutions.length) throw new AppError('invalid_question_reference', '问题关闭记录重复。', 502);
    for (const resolution of resolutions) {
      const record = this.list(project.id).find(q => q.id === resolution.questionId && q.stage === stage && q.status !== 'resolved');
      if (!record) throw new AppError('invalid_question_reference', 'AI 尝试关闭未知、已解决或不属于当前阶段的问题，未应用结果。', 502);
      if (returned.some(q => q.questionId === record.id)) throw new AppError('invalid_question_reference', '问题不能同时关闭和继续提问，未应用结果。', 502);
      try {
        userEvidence(project, resolution.evidence, record.openedAfter);
        const lastAnswer = record.lastAnswerMessageId ? project.conversation.findIndex(m => m.id === record.lastAnswerMessageId) : -1;
        if (resolution.evidence.some(e => project.conversation.findIndex(m => m.id === e.messageId) < lastAnswer)) throw new AppError('invalid_evidence', '问题关闭不能引用比该题最新决定更旧的答复。', 502);
      } catch (error) {
        if (error instanceof AppError) {
          error.message = `「${record.question.title}」：${error.message} 已保存的答复保留，本轮审查未应用。`;
          error.questionDiagnostic = { questionId: record.id, evidenceMessageIds: resolution.evidence.filter(e => project.conversation.some(m => m.id === e.messageId)).map(e => e.messageId), ...(record.lastAnswerMessageId ? { latestAnswerMessageId: record.lastAnswerMessageId } : {}) };
        }
        throw error;
      }
      if ((record.requiresAcceptance || 'kind' in record.question && record.question.kind === 'conflict') && !record.acceptedProposal) {
        throw new AppError('proposal_confirmation_required', '未接受解决规则，不能关闭冲突。', 502);
      }
      this.put(project.id, { ...record, status: 'resolved', resolution });
    }
  }
  active(project: Project, stage: QuestionRecord['stage']): Question[] {
    return this.list(project.id).filter(q => q.stage === stage && q.status !== 'resolved').map(q => {
      // Omitted/stale conflict options cannot accept an expired Proposal.
      if ('proposals' in q.question && q.question.proposals.length && !project.review?.issues.some(i => i.id === q.id)) {
        return { ...q.question, answerMode: 'custom_only', options: unsureOptions(), proposals: [] } as ReviewIssue;
      }
      return q.question;
    });
  }
}
export const unsureOptions = () => [{ key: 'C' as const, label: '暂不确定', answer: '暂不确定', impact: '保持待决定，需要补充资料或重新生成方案。', unsure: true, proposalIndex: null }];
