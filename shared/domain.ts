import { z } from 'zod';

const text = z.string().max(12000);
export const confirmationText = '这就是我希望实现的第一版 MVP 产品逻辑。';
export const evolutionConfirmationText = '这就是我希望更新后的当前产品逻辑。';
export const proposalConfirmationText = '确认所选决定并接受解决规则';
export const gateKeys = ['clarity', 'boundary', 'consistency', 'verifiability'] as const;
export type GateKey = typeof gateKeys[number];
export const coveredGatesSchema = z.array(z.enum(gateKeys)).min(1).max(4);
export function questionGates(question: { gate: GateKey; coveredGates?: GateKey[] }): GateKey[] {
  return question.coveredGates ?? [question.gate];
}
export function undecidedAnswer(answer: string): boolean {
  return /^(暂不确定|尚未决定|还没想好|不知道|不确定|帮我填|帮我填写|帮我决定|你来决定|你来定)[。！!？?\s]*$/.test(answer.trim());
}
export const evidenceSchema = z.strictObject({ messageId: z.string().min(1), quote: text.min(1) });
export type Evidence = z.infer<typeof evidenceSchema>;
export const quantitativeRequirementSchema = z.strictObject({ metric: text.min(1), target: text.nullable(), sample: text.nullable() });
export const verificationSchema = z.strictObject({
  type: z.enum(['Agent', 'Human', 'Hybrid']),
  agentProcess: text, expectedAgentResult: text,
  agentSideReview: text, humanTest: text, observability: text, expectedHumanResult: text,
  quantitativeRequirements: z.array(quantitativeRequirementSchema).max(30).optional(),
});
// Persisted old payloads remain readable; live model output must name every field.
export const modelVerificationSchema = verificationSchema.extend({ quantitativeRequirements: z.array(quantitativeRequirementSchema).max(30) });
export type Verification = z.infer<typeof verificationSchema>;
export function sameVerification(a: Verification | null, b: Verification | null): boolean {
  if (!a || !b) return a === b;
  const requirements = (value: Verification) => (value.quantitativeRequirements ?? []).map(q => [q.metric, q.target, q.sample]);
  return ['type', 'agentProcess', 'expectedAgentResult', 'agentSideReview', 'humanTest', 'observability', 'expectedHumanResult'].every(key => a[key as keyof Verification] === b[key as keyof Verification]) &&
    JSON.stringify(requirements(a)) === JSON.stringify(requirements(b));
}
export const fieldsSchema = z.strictObject({
  name: z.string().max(200), description: text, purpose: text,
  applicableState: text, coreRule: text,
});
export type CandidateFields = z.infer<typeof fieldsSchema>;
export const reviewFieldKeys = ['name', 'description', 'purpose', 'applicableState', 'coreRule', 'verification'] as const;
export const affectedFieldsSchema = z.array(z.strictObject({ p0Id: z.string(), fields: z.array(z.enum(reviewFieldKeys)).min(1).max(6) })).max(50);
export const candidateSchema = fieldsSchema.extend({
  id: z.string().min(1).max(100), source: text,
  confirmedException: text, verification: verificationSchema.nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const draftSchema = z.strictObject({
  productDescription: z.string().min(1).max(12000),
  coreUserGoal: z.string().min(1).max(12000),
  productConcept: text.default(''),
  candidates: z.array(candidateSchema).min(1).max(50),
});
export type Draft = z.infer<typeof draftSchema>;
export const decisionOptionSchema = z.strictObject({
  key: z.enum(['A', 'B', 'C']), label: z.string().trim().min(1).max(300),
  answer: text.min(1), impact: z.string().min(1).max(2000), unsure: z.boolean(),
  proposalIndex: z.number().int().min(0).max(2).nullable(),
});
export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export const conceptQuestionSchema = z.strictObject({
  title: z.string().min(1).max(300), question: text.min(1), reason: z.string().min(1).max(2000),
  options: z.array(decisionOptionSchema).min(1).max(3),
  answerMode: z.enum(['choices', 'custom_only']), questionId: z.string().nullable(),
});
export const resolutionSchema = z.strictObject({ questionId: z.string().min(1), reason: text.min(1), evidence: z.array(evidenceSchema).min(1).max(10) });
export const conceptDefinitionSchema = z.strictObject({
  name: z.string().trim().max(200), productDescription: text, coreUserGoal: text, productConcept: text,
  features: z.array(z.strictObject({ name: z.string().trim().min(1).max(200), description: text.min(1) })).max(50),
});
export const conceptAnalysisSchema = z.strictObject({
  definition: conceptDefinitionSchema, questions: z.array(conceptQuestionSchema).max(100),
  resolvedQuestions: z.array(resolutionSchema).max(100),
});
export type ConceptDefinition = z.infer<typeof conceptDefinitionSchema>;
export type ConceptAnalysis = z.infer<typeof conceptAnalysisSchema>;
export type ConceptQuestion = z.infer<typeof conceptQuestionSchema> & { id: string };
export type ConceptIntake = { conceptInput: string; definition: ConceptDefinition | null; questions: ConceptQuestion[] };
export const decisionAnswerSchema = z.strictObject({
  issueId: z.string().min(1).max(100), choice: z.enum(['A', 'B', 'C', 'D']),
  customAnswer: z.string().trim().max(12000).optional(),
});
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;
export const decisionBatchSchema = z.strictObject({
  answers: z.array(decisionAnswerSchema).default([]),
  proposalAcceptances: z.array(z.strictObject({ issueId: z.string().min(1).max(100), proposalId: z.string().min(1).max(100) })).default([]),
  confirmation: z.string().max(100).optional(),
});
export type DecisionBatch = z.infer<typeof decisionBatchSchema>;
export const mergeConfirmationText = '确认合并重复问题并采用本次答复';
export const questionMergeSchema = z.strictObject({
  questionIds: z.array(z.string().min(1)).min(2).max(100), primaryQuestionId: z.string().min(1),
  answer: decisionAnswerSchema, confirmation: z.literal(mergeConfirmationText),
});
export type QuestionMerge = z.infer<typeof questionMergeSchema>;
export const gateSchema = z.strictObject({
  status: z.enum(['pass', 'needs_clarification', 'conflict_detected', 'verification_undefined']),
  reason: z.string().max(2000),
});
export type Gate = z.infer<typeof gateSchema>;
export const gatesSchema = z.strictObject({
  clarity: gateSchema, boundary: gateSchema, consistency: gateSchema, verifiability: gateSchema,
});
export type Gates = z.infer<typeof gatesSchema>;
const proposalSchema = z.strictObject({ label: z.string().max(200), rule: text.min(1) });
const issueBase = z.strictObject({
  p0Ids: z.array(z.string()).min(1).max(50), title: z.string().max(300),
  question: text.min(1), condition: text, ruleA: text, ruleB: text, explanation: text,
  options: z.array(decisionOptionSchema).min(1).max(3),
  answerMode: z.enum(['choices', 'custom_only']), questionId: z.string().nullable(),
  affectedFields: affectedFieldsSchema.optional(),
  coveredGates: coveredGatesSchema.optional(),
});
// Ordinary union emits nested anyOf, which the public Responses route supports.
// Zod's discriminatedUnion emits oneOf and is rejected by that route.
export const issueSchema = z.union([
  issueBase.extend({ kind: z.literal('conflict'), gate: z.literal('consistency'),
    p0Ids: z.array(z.string()).min(1).max(50), condition: text.min(1), ruleA: text.min(1), ruleB: text.min(1), explanation: text.min(1),
    proposals: z.array(proposalSchema).max(5) }),
  issueBase.extend({ kind: z.literal('clarification'), gate: z.enum(gateKeys), proposals: z.array(proposalSchema).max(0) }),
  issueBase.extend({ kind: z.literal('verification'), gate: z.literal('verifiability'), proposals: z.array(proposalSchema).max(0) }),
]);
export const analysisSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: z.string(), fields: fieldsSchema, verification: modelVerificationSchema.nullable(), gates: gatesSchema,
    quantitativeSources: z.array(z.strictObject({ requirementIndex: z.number().int().min(0), evidence: z.array(evidenceSchema).min(1).max(10) })).max(30),
  })).min(1).max(50),
  issues: z.array(issueSchema).max(100),
  resolvedQuestions: z.array(resolutionSchema).max(100),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type ReviewIssue = Omit<z.infer<typeof issueSchema>, 'proposals'> & {
  id: string; proposals: Array<{ id: string; label: string; rule: string; changes?: IntegrationChange[] }>;
};
export type Review = { revision: number; ledgerVersion?: 1; items: Array<{ id: string; gates: Gates }>; issues: ReviewIssue[] };
export type QuestionRecord = {
  id: string; stage: 'concept' | 'candidate' | 'integration' | 'legacy'; status: 'pending_answer' | 'pending_review' | 'undecided' | 'resolved';
  p0Ids: string[]; gate: GateKey; createdRevision: number; createdBasis: string; openedAfter: string | null;
  question: ConceptQuestion | ReviewIssue; acceptedProposal: boolean;
  lastAnswerMessageId?: string;
  requiresAcceptance?: boolean;
  resolution: z.infer<typeof resolutionSchema> | null;
  merge?: { targetQuestionId: string; originalStage: 'candidate'; messageId: string; revision: number };
};
export const additionItemSchema = z.strictObject({
  kind: z.enum(['new_p0', 'existing_p0', 'needs_clarification']),
  name: z.string().trim().max(200), description: text,
  targetP0Id: z.string().nullable(), relatedP0Ids: z.array(z.string()).max(50),
  reason: text.min(1), question: text,
});
export const additionAnalysisSchema = z.strictObject({ items: z.array(additionItemSchema).min(1).max(50) });
export type AdditionAnalysis = z.infer<typeof additionAnalysisSchema>;
export const changeFields = ['name', 'description', 'purpose', 'applicableState', 'coreRule', 'confirmedException'] as const;
export const integrationChangeSchema = z.strictObject({ p0Id: z.string(), field: z.enum(changeFields), value: text });
export const integrationIssueSchema = z.union([
  issueSchema.options[0].omit({ affectedFields: true, coveredGates: true }).extend({ proposals: z.array(proposalSchema.extend({ changes: z.array(integrationChangeSchema).max(300) })).max(3) }),
  issueSchema.options[1].omit({ affectedFields: true, coveredGates: true }).extend({ gate: z.literal('consistency'), proposals: z.array(proposalSchema.extend({ changes: z.array(integrationChangeSchema).max(300) })).max(3) }),
]);
export const integrationAnalysisSchema = z.strictObject({
  summary: text.min(1), checkedP0Ids: z.array(z.string()).min(1).max(50),
  issues: z.array(integrationIssueSchema).max(100), resolvedQuestions: z.array(resolutionSchema).max(100),
});
export type IntegrationAnalysis = z.infer<typeof integrationAnalysisSchema>;
export type IntegrationChange = z.infer<typeof integrationChangeSchema>;
export type ReviewField = keyof CandidateFields | 'verification';
export type BaselineVersion = `v${number}`;
export type FeatureAddition = {
  request: string; baseVersion: BaselineVersion; phase: 'intake' | 'integration' | 'review';
  assessment: AdditionAnalysis | null; editableP0Ids: string[]; newP0Id?: string;
  integrationQuestionId?: string;
  members?: Array<{ index: number; p0Id: string }>;
  fieldPermissions?: Record<string, ReviewField[]>;
  integration?: { revision: number; summary: string; issues: ReviewIssue[] };
};
export type Baseline = {
  productDescription: string; coreUserGoal: string; baselineVersion: BaselineVersion; createdAt: string;
  productConcept?: string;
  p0Items: Array<Omit<Candidate, 'source'>>;
};
export type ProjectSummary = { id: string; name: string; createdAt: string; committed: boolean; currentVersion?: BaselineVersion };
export type Project = ProjectSummary & {
  stage: 'concept' | 'candidate' | 'committed' | 'addition' | 'integration'; intake: ConceptIntake | null;
  revision: number; draft: Draft; review: Review | null; baseline: Baseline | null;
  questions: QuestionRecord[];
  addition?: FeatureAddition | null;
  baselineHistory?: Array<{ version: BaselineVersion; createdAt: string }>;
  conversation: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>;
  status: 'Draft' | 'Needs Clarification' | 'Conflict Detected' | 'Verification Undefined' | 'Ready' | 'Awaiting User Confirmation' | 'Committed';
};

export function conceptReady(intake: ConceptIntake | null): boolean {
  const d = intake?.definition;
  return Boolean(d && !intake!.questions.length && d.productDescription.trim() && d.coreUserGoal.trim() &&
    d.productConcept.trim() && d.features.length > 0 && d.features.every(f => f.name.trim() && f.description.trim()));
}

export function verificationProblem(value: Verification | null): string | null {
  if (!value) return '尚未定义 Verification。';
  if ((value.type === 'Agent' || value.type === 'Hybrid') &&
      (!value.agentProcess.trim() || !value.expectedAgentResult.trim())) return '需要 Agent 验证步骤和预期结果。';
  if ((value.type === 'Human' || value.type === 'Hybrid') &&
      (!value.agentSideReview.trim() || !value.humanTest.trim() || !value.observability.trim() || !value.expectedHumanResult.trim())) {
    return '需要 Agent-side Review、人工测试、可观测要求及预期人工结果；不需要额外观测工具时请明确说明。';
  }
  const expected = [value.type !== 'Human' ? value.expectedAgentResult : '', value.type !== 'Agent' ? value.expectedHumanResult : ''].filter(Boolean);
  if (expected.some(s => /^(应该正常|正常|运行正常|功能正常|未定义|待确定|符合预期)[。.!！\s]*$/.test(s.trim()))) return '预期结果需要具体可观察的判断标准，不能只写应该正常或未定义。';
  if (value.quantitativeRequirements?.some(q => !q.target?.trim() || /^(未定义|待定|待确定|未知|应该正常|符合预期)[。！!\s]*$/.test(q.target.trim()))) return '已要求量化验收，但必要门槛尚未定义。';
  return null;
}
export function ready(draft: Draft, revision: number, review: Review | null, questions: QuestionRecord[] = [], addition?: FeatureAddition | null): boolean {
  return Boolean(review && review.ledgerVersion === 1 && review.revision === revision && review.issues.length === 0 &&
    (!addition || addition.phase === 'review' && addition.integration) &&
    !questions.some(q => q.stage !== 'legacy' && q.status !== 'resolved') &&
    review.items.length === draft.candidates.length && draft.candidates.every(c => {
      const item = review.items.find(i => i.id === c.id);
      return c.name.trim() && c.description.trim() && c.purpose.trim() && c.applicableState.trim() && c.coreRule.trim() &&
        !verificationProblem(c.verification) && item && gateKeys.every(key => item.gates[key].status === 'pass');
    }));
}
