import { z } from 'zod';
import { analysisSchema, conceptAnalysisSchema, conceptQuestionSchema, gatesSchema, issueSchema, resolutionSchema, integrationAnalysisSchema, integrationIssueSchema, affectedFieldsSchema, coveredGatesSchema } from '../shared/domain.js';
import type { Analysis, Project, QuestionRecord, CandidateFields } from '../shared/domain.js';
import { editableFields } from './addition-review.js';

function questionScope(project: Project, stage: QuestionRecord['stage']) {
  const ids = project.questions.filter(q => q.stage === stage && q.status !== 'resolved').map(q => q.id);
  return { questionId: ids.length ? z.enum(ids).nullable() : z.null(),
    resolvedQuestions: ids.length ? z.array(resolutionSchema.extend({ questionId: z.enum(ids) })).max(Math.min(ids.length, 100)) : z.array(resolutionSchema).max(0) };
}
export function conceptResultSchema(project: Project) {
  const scope = questionScope(project, 'concept');
  return conceptAnalysisSchema.extend({ questions: z.array(conceptQuestionSchema.extend({ questionId: scope.questionId })).max(100), resolvedQuestions: scope.resolvedQuestions });
}
// First and subsequent versions use the same complete MVP result contract.
export function reviewResultSchema(project: Project) {
  const scope = questionScope(project, 'candidate');
  const shape = Object.fromEntries(project.draft.candidates.map(c => {
    const allowed = editableFields(project, c.id);
    const update = analysisSchema.shape.items.element.omit({ id: true }).extend({ mode: z.literal('update'),
      fields: z.strictObject(Object.fromEntries(Object.entries(analysisSchema.shape.items.element.shape.fields.shape).map(([key, schema]) =>
        [key, allowed.includes(key as keyof CandidateFields) ? schema : z.literal(c[key as keyof CandidateFields])]))) });
    return [c.id, allowed.length ? update : z.strictObject({ mode: z.literal('preserve'), gates: gatesSchema })];
  }));
  return analysisSchema.extend({ items: z.strictObject(shape),
    issues: z.array(z.union([issueSchema.options[0].extend({ questionId: scope.questionId, affectedFields: affectedFieldsSchema, coveredGates: coveredGatesSchema }), issueSchema.options[1].extend({ questionId: scope.questionId, affectedFields: affectedFieldsSchema, coveredGates: coveredGatesSchema }), issueSchema.options[2].extend({ questionId: scope.questionId, affectedFields: affectedFieldsSchema, coveredGates: coveredGatesSchema })])).max(100),
    resolvedQuestions: scope.resolvedQuestions });
}
export function expandReviewResult(project: Project, result: z.output<ReturnType<typeof reviewResultSchema>>): Analysis {
  return analysisSchema.parse({ ...result, items: project.draft.candidates.map(c => {
    const item = result.items[c.id] as { mode: string; gates: unknown };
    if (item.mode === 'update') { const { mode: _mode, ...complete } = item; return { id: c.id, ...complete }; }
    return { id: c.id, gates: item.gates, fields: { name: c.name, description: c.description, purpose: c.purpose, applicableState: c.applicableState, coreRule: c.coreRule },
      verification: c.verification ? { ...c.verification, quantitativeRequirements: c.verification.quantitativeRequirements ?? [] } : null, quantitativeSources: [] };
  }) });
}
export function integrationResultSchema(project: Project) {
  const scope = questionScope(project, 'integration');
  return integrationAnalysisSchema.extend({
    issues: z.array(z.union([integrationIssueSchema.options[0].extend({ questionId: scope.questionId }), integrationIssueSchema.options[1].extend({ questionId: scope.questionId })])).max(100),
    resolvedQuestions: scope.resolvedQuestions,
  });
}
