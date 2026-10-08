import { describe, expect, it, vi } from 'vitest';
import { ChatGPTProvider, reviewInstructions, conceptInstructions } from '../server/provider.js';
import { streamResponse } from '../vendor/siwc-local/src/responses.js';
import type { ChatGPTClient } from '@siwc/local';
import { Store } from '../server/store.js';
import { makeAnalysis, makeConcept, makeAdditionReviewResponse } from './fixtures.js';
import { analysisSchema } from '../shared/domain.js';

describe('Structured provider', () => {
  it('uses an independent strict concept request and sends the original premise', async () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ conceptInput: '有玩偶随机巡查，离席会扣心。' });
      const mock = { listModels: vi.fn().mockResolvedValue([{ slug: 'gpt-6.1-sol' }]), streamResponse: vi.fn().mockResolvedValue({ text: JSON.stringify(makeConcept(p)) }) };
      const provider = new ChatGPTProvider(mock as unknown as ChatGPTClient);
      const result = await provider.developConcept(p, new AbortController().signal, { effort: 'high' });
      expect(result.questions).toHaveLength(1);
      const request = mock.streamResponse.mock.calls[0]![0];
      expect(request.instructions).toBe(conceptInstructions); expect(request.text.format.name).toBe('product_concept');
      expect(request.text.format.strict).toBe(true); expect(request.reasoning.effort).toBe('high');
      expect(JSON.parse(request.input[0].content).intake.conceptInput).toBe(p.intake!.conceptInput);
      expect(JSON.stringify(request.text.format.schema)).not.toContain('"oneOf"');
      expect(request.text.format.schema.required).toEqual(['definition', 'questions', 'resolvedQuestions']);
      mock.streamResponse.mockResolvedValueOnce({ text: '{"definition":{}}' });
      await expect(provider.developConcept(p, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_analysis' });
      expect(store.get(p.id).intake!.definition).toBeNull();
    } finally { store.close(); }
  });
  it('encodes conflict evidence and proposal restrictions in the output schema', () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one', 'two', 'three'] });
      const result = makeAnalysis(p, true);
      expect(analysisSchema.safeParse(result).success).toBe(true);
      const badEvidence = structuredClone(result); badEvidence.issues[0]!.ruleA = '';
      expect(analysisSchema.safeParse(badEvidence).success).toBe(false);
      const unconfirmed = structuredClone(result); unconfirmed.issues[0]!.kind = 'clarification';
      expect(analysisSchema.safeParse(unconfirmed).success).toBe(false);
      unconfirmed.issues[0]!.proposals = [];
      expect(analysisSchema.safeParse(unconfirmed).success).toBe(true);
    } finally { store.close(); }
  });
  it('sends strict schema, chooses the available default and preserves all candidates', async () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one', 'two'] });
      const mock = { listModels: vi.fn().mockResolvedValue([{ slug: 'gpt-6.1-sol', displayName: 'GPT' }]), streamResponse: vi.fn().mockResolvedValue({ text: JSON.stringify(makeAdditionReviewResponse(p)) }) };
      const provider = new ChatGPTProvider(mock as unknown as ChatGPTClient);
      const result = await provider.analyze(p, new AbortController().signal);
      expect(result.items).toHaveLength(2);
      const request = mock.streamResponse.mock.calls[0]![0];
      expect(request.model).toBe('gpt-6.1-sol'); expect(request.text.format.strict).toBe(true);
      expect(request.reasoning).toEqual({ effort: 'high' });
      expect(JSON.stringify(request.text.format.schema)).not.toContain('"oneOf"');
      expect(JSON.stringify(request.text.format.schema)).toContain('"anyOf"');
      expect(request.input[0].role).toBe('user'); expect(request.instructions).toContain(reviewInstructions);
      mock.streamResponse.mockResolvedValueOnce({ text: '```json invalid' });
      await expect(provider.analyze(p, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_analysis' });
      expect(store.get(p.id).revision).toBe(p.revision);
    } finally { store.close(); }
  });
  it('uses the first appropriate account model and fails clearly when no model exists', async () => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one'] });
      const mock = { listModels: vi.fn().mockResolvedValue([{ slug: 'gpt-image-1' }, { slug: 'gpt-6-sol' }]), streamResponse: vi.fn().mockResolvedValue({ text: JSON.stringify(makeAdditionReviewResponse(p)) }) };
      const provider = new ChatGPTProvider(mock as unknown as ChatGPTClient);
      await provider.analyze(p, new AbortController().signal);
      expect(mock.streamResponse.mock.calls[0]![0].model).toBe('gpt-6-sol');
      await provider.analyze(p, new AbortController().signal, { model: 'gpt-6-sol', effort: 'medium' });
      expect(mock.streamResponse.mock.calls[1]![0]).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'medium' } });
      await expect(provider.analyze(p, new AbortController().signal, { model: 'gpt-6.1-sol', effort: 'high' })).rejects.toMatchObject({ code: 'model_unavailable' });
      expect(mock.streamResponse).toHaveBeenCalledTimes(2);
      mock.listModels.mockResolvedValueOnce([]);
      await expect(provider.analyze(p, new AbortController().signal)).rejects.toMatchObject({ code: 'no_model' });
    } finally { store.close(); }
  });
});
describe('Official stream adapter with schema extension', () => {
  function sse(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }
  it('serializes public plan route requirements and waits for completed inference', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse([{ type: 'response.output_text.delta', delta: '{"ok":true}' }, { type: 'response.completed' }]));
    try {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      const result = await streamResponse('synthetic-test-token', { model: 'gpt-6.1-sol', input: 'input', reasoning: { effort: 'high' }, text: { format: { type: 'json_schema', name: 'test', strict: true, schema } } }, new AbortController().signal);
      expect(result.text).toBe('{"ok":true}');
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(options!.body));
      expect(body.store).toBe(false); expect(body.stream).toBe(true); expect(Array.isArray(body.input)).toBe(true); expect(body.text.format.schema).toEqual(schema);
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('previous_response_id');
    } finally { fetcher.mockRestore(); }
  });
  it.each([
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete' }],
    [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }],
  ])('rejects incomplete, interrupted or quota-failed responses', async events => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse(Array.isArray(events) ? events : [events]));
    try { await expect(streamResponse('synthetic', { model: 'gpt-6.1-sol', input: 'input' }, new AbortController().signal)).rejects.toThrow(); }
    finally { fetcher.mockRestore(); }
  });
});
