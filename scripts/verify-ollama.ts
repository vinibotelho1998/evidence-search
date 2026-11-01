import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Json = Record<string, unknown>;
type Step = { name: string; elapsedMs: number; details: unknown };

const evidenceUrl = process.env.EVIDENCE_URL ?? 'http://127.0.0.1:8004';
const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const embeddingModel = process.env.EMBEDDING_MODEL ?? 'embeddinggemma:300m';
const generationModel = process.env.GENERATION_MODEL ?? 'qwen2.5:1.5b';
const apiKey = process.env.EVIDENCE_API_KEY ?? 'demo-team-a';
const otherKey = process.env.EVIDENCE_OTHER_API_KEY ?? 'demo-team-b';
const reportPath = process.env.INTEGRATION_REPORT ?? 'var/ollama-integration.json';
const timeoutMs = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 120_000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600_000);

const id = `ollama-proof-${randomUUID()}`;
const document = {
  id, title: 'Política fictícia Atlas-N9', source: 'integration-fixture/atlas-n9.md',
  text: 'O serviço Atlas-N9 aceita pedidos de reembolso em até 37 dias corridos após a compra.\nO comprovante de pagamento é obrigatório.\nA solicitação deve ser enviada pelo portal de atendimento.',
};
const query = 'Quantos dias após a compra o serviço Atlas-N9 aceita pedidos de reembolso?';
const steps: Step[] = [];
const report: Json = {
  startedAt: new Date().toISOString(), validation: 'real Ollama and real Evidence Search HTTP API',
  models: { embedding: embeddingModel, generation: generationModel }, fixture: { id, expectedDays: 37 }, steps,
};

async function json(base: string, path: string, body?: Json, key?: string, method?: string) {
  const response = await fetch(new URL(path, base), {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json() as Json;
  assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function step(name: string, operation: () => Promise<unknown>) {
  const started = performance.now();
  const details = await operation();
  const result = { name, elapsedMs: Math.round(performance.now() - started), details };
  steps.push(result);
  console.log(JSON.stringify(result));
}

let inserted = false;
try {
  await step('model-preflight', async () => {
    const version = await json(ollamaUrl, '/api/version');
    const embedding = await json(ollamaUrl, '/api/show', { model: embeddingModel });
    const generation = await json(ollamaUrl, '/api/show', { model: generationModel });
    assert.ok(Array.isArray(embedding.capabilities) && embedding.capabilities.includes('embedding'), 'Embedding model capability missing');
    assert.ok(Array.isArray(generation.capabilities) && generation.capabilities.includes('completion'), 'Generation model capability missing');
    return { version: version.version, embeddingCapabilities: embedding.capabilities, generationCapabilities: generation.capabilities };
  });

  await step('real-embedding-batch', async () => {
    const response = await json(ollamaUrl, '/api/embed', {
      model: embeddingModel, input: [document.text, query], truncate: false,
    });
    assert.ok(Array.isArray(response.embeddings) && response.embeddings.length === 2);
    const vectors = response.embeddings as number[][];
    assert.ok(vectors.every(vector => Array.isArray(vector) && vector.length > 0 &&
      vector.every(value => typeof value === 'number' && Number.isFinite(value))));
    assert.equal(vectors[0]!.length, vectors[1]!.length);
    assert.ok(vectors.every(vector => vector.some(value => value !== 0)));
    return { model: response.model, dimensions: vectors[0]!.length, promptTokens: response.prompt_eval_count, totalDurationNs: response.total_duration };
  });

  await step('semantic-api-ready', async () => {
    const health = await json(evidenceUrl, '/health');
    assert.equal(health.mode, 'semantic', 'Configure SEARCH_MODE=semantic before this integration check');
    return health;
  });

  await step('ingest-real-embeddings', async () => {
    const result = await json(evidenceUrl, '/v1/documents', document, apiKey);
    inserted = true;
    assert.equal(result.mode, 'semantic');
    assert.ok(Number(result.chunks) >= 1);
    return result;
  });

  await step('semantic-retrieval-and-tenant-isolation', async () => {
    const found = await json(evidenceUrl, '/v1/search', { query, topK: 5 }, apiKey);
    const results = found.results as Json[];
    assert.ok(Array.isArray(results));
    const matching = results.find(item => item.documentId === id);
    assert.ok(matching, 'The indexed fixture was not retrieved');
    assert.ok(String(matching.text).includes('37'));
    const other = await json(evidenceUrl, '/v1/search', { query, topK: 20, tenant: 'team-a' }, otherKey);
    assert.ok(!(other.results as Json[]).some(item => item.documentId === id), 'Cross-tenant document leakage');
    return { retrieved: matching, otherTenantReturnedFixture: false };
  });

  await step('real-generation-with-supported-citations', async () => {
    const result = await json(evidenceUrl, '/v1/answer', { query }, apiKey);
    assert.equal(result.generated, true);
    assert.equal(result.reason, null);
    assert.ok(typeof result.answer === 'string' && /\b37\b/.test(result.answer), 'The generated answer must preserve the fixture fact');
    assert.ok(Array.isArray(result.evidence));
    const evidence = result.evidence as Json[];
    const citations = [...result.answer.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!);
    assert.ok(citations.length > 0);
    assert.ok(citations.every(citation => evidence.some(item => item.chunkId === citation)));
    assert.ok(citations.some(citation => evidence.some(item => item.chunkId === citation && item.documentId === id)));
    return { answer: result.answer, citations, evidence };
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (inserted) {
    try {
      await step('cleanup-owned-fixture', () => json(evidenceUrl, `/v1/documents/${id}`, undefined, apiKey, 'DELETE'));
    } catch (error) {
      report.passed = false;
      report.cleanupError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Integration report: ${reportPath}; passed=${report.passed}`);
}
