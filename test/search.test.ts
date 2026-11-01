import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DocumentStore } from '../src/store.ts';
import { SearchService } from '../src/search.ts';
import { chunkText, cosine } from '../src/text.ts';
import { createApp } from '../src/http.ts';
import { createOllama } from '../src/ollama.ts';
import { createServer } from 'node:http';

const unused = { embed: async (_texts: string[]): Promise<number[][]> => { throw new Error('unexpected embedding call'); }, generate: async () => '' };
const document = { id: 'refunds', title: 'Reembolsos', source: 'manual.md', text: 'Reembolso de despesas em trinta dias. Comprovante obrigatorio.' };
function fixture() {
  const store = new DocumentStore(':memory:');
  return { store, service: new SearchService(store, { mode: 'lexical', embeddingModel: '', generationEnabled: false, client: unused }) };
}

test('chunks preserve line references even when a long line is split', () => {
  const chunks = chunkText('doc', 'abc\ndefghijk\nlmn', 5);
  assert.deepEqual(chunks.map(chunk => [chunk.startLine, chunk.endLine]), [[1, 1], [2, 2], [2, 2], [3, 3]]);
  assert.equal(chunkText('empty', ' \n ').length, 0);
});
test('cosine rejects mismatched dimensions instead of comparing incompatible models', () => {
  assert.throws(() => cosine([1], [1, 2]), /Dimensoes/);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});
test('search filters by team before ranking and replacing keeps the other team intact', async () => {
  const { store, service } = fixture();
  try {
    await service.ingest('a', document);
    await service.ingest('b', { ...document, text: 'Reembolso secreto da equipe b em cinco dias.' });
    assert.match((await service.search('a', 'reembolso'))[0]!.text, /trinta/);
    assert.equal((await service.search('a', 'secreto')).length, 0);
    await service.ingest('a', { ...document, text: 'Reembolso atualizado.' });
    assert.equal(store.chunks('a').length, 1);
    assert.match(store.chunks('b')[0]!.text, /secreto/);
    assert.equal(store.delete('a', 'refunds'), true);
    assert.equal(store.chunks('b').length, 1);
  } finally { store.close(); }
});
test('offline answers report evidence without pretending to call a language model', async () => {
  const { store, service } = fixture();
  try {
    await service.ingest('a', document);
    assert.equal((await service.answer('a', 'reembolso')).reason, 'generation_disabled');
    assert.equal((await service.answer('a', 'astronomia')).reason, 'no_evidence');
  } finally { store.close(); }
});
test('a provider failure cannot delete an existing document', async () => {
  const { store, service } = fixture();
  try {
    await service.ingest('a', document);
    const semantic = new SearchService(store, { mode: 'semantic', embeddingModel: 'test', generationEnabled: false, client: unused });
    await assert.rejects(semantic.ingest('a', { ...document, text: 'replacement' }));
    assert.equal(store.chunks('a')[0]!.text, document.text);
  } finally { store.close(); }
});
test('semantic mode uses embeddings, catches a model change and rejects fabricated citations', async () => {
  const store = new DocumentStore(':memory:');
  const client = { embed: async (texts: string[]) => texts.map(() => [1, 0]),
    generate: async () => JSON.stringify({ answer: 'Resposta', citations: ['documento-inexistente:0'], abstain: false }) };
  const service = new SearchService(store, { mode: 'semantic', embeddingModel: 'model-a', generationEnabled: true, client });
  try {
    await service.ingest('a', document);
    assert.equal((await service.search('a', 'politica de despesas'))[0]!.score, 1);
    await assert.rejects(service.answer('a', 'despesas'), /citacoes/);
    service.options.embeddingModel = 'model-b';
    await assert.rejects(service.search('a', 'despesas'), /Reimporte/);
  } finally { store.close(); }
});

test('answer uses a citation enum and still validates provider output at runtime', async () => {
  const store = new DocumentStore(':memory:'); let generatedPrompt = ''; let requestedFormat: Record<string, unknown> | undefined; let cite = false;
  const client = {
    embed: async (texts: string[]) => texts.map(() => [1, 0]),
    generate: async (prompt: string, format?: Record<string, unknown>) => {
      generatedPrompt = prompt;
      requestedFormat = format;
      return JSON.stringify({ answer: 'O prazo e trinta dias', citations: cite ? ['refunds:0'] : [], abstain: false });
    },
  };
  const service = new SearchService(store, { mode: 'semantic', embeddingModel: 'test-model', generationEnabled: true, client });
  try {
    await service.ingest('a', document);
    await assert.rejects(service.answer('a', 'Qual e o prazo?'), { code: 'invalid_citations' });
    assert.match(generatedPrompt, /IDs permitidos: \["refunds:0"\]/);
    const properties = requestedFormat!.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual((properties.citations!.items as Record<string, unknown>).enum, ['refunds:0']);
    cite = true;
    assert.equal((await service.answer('a', 'Qual e o prazo?')).answer, 'O prazo e trinta dias [refunds:0]');
  } finally { store.close(); }
});

test('structured generation rejects invalid JSON and incomplete schemas', async () => {
  const store = new DocumentStore(':memory:'); let raw = 'plain text without JSON';
  const client = { embed: async (texts: string[]) => texts.map(() => [1, 0]), generate: async () => raw };
  const service = new SearchService(store, { mode: 'semantic', embeddingModel: 'test-model', generationEnabled: true, client });
  try {
    await service.ingest('a', document);
    for (const invalid of ['plain text without JSON', 'null', '[]', '{"answer":"x","citations":[]}', '{"answer":"x","citations":[1],"abstain":false}']) {
      raw = invalid;
      await assert.rejects(service.answer('a', 'Qual e o prazo?'), { code: 'invalid_generation_format' });
    }
  } finally { store.close(); }
});

test('structured abstention stays explicit and does not produce fabricated sources', async () => {
  const store = new DocumentStore(':memory:');
  const client = { embed: async (texts: string[]) => texts.map(() => [1, 0]),
    generate: async () => JSON.stringify({ answer: '', citations: [], abstain: true }) };
  const service = new SearchService(store, { mode: 'semantic', embeddingModel: 'test-model', generationEnabled: true, client });
  try {
    await service.ingest('a', document);
    const result = await service.answer('a', 'Quem e o presidente da empresa?');
    assert.equal(result.answer, null);
    assert.equal(result.reason, 'model_abstained');
    assert.equal(result.generated, true);
  } finally { store.close(); }
});

test('a valid citation array cannot hide an invented inline citation', async () => {
  const store = new DocumentStore(':memory:');
  const client = { embed: async (texts: string[]) => texts.map(() => [1, 0]),
    generate: async () => JSON.stringify({ answer: 'Prazo de trinta dias [inventado:0]', citations: ['refunds:0'], abstain: false }) };
  const service = new SearchService(store, { mode: 'semantic', embeddingModel: 'test-model', generationEnabled: true, client });
  try {
    await service.ingest('a', document);
    await assert.rejects(service.answer('a', 'Qual e o prazo?'), { code: 'invalid_citations' });
  } finally { store.close(); }
});
test('HTTP validates credentials, JSON, bounds and ignores a client-supplied team', async () => {
  const { store, service } = fixture();
  await service.ingest('secret', document);
  const server = createApp(service, { 'public-test-key': 'public', 'secret-test-key': 'secret' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST' })).status, 401);
    const headers = { authorization: 'Bearer public-test-key', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'x', topK: 99 }) })).status, 400);
    const response = await fetch(`${base}/v1/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'reembolso', tenant: 'secret' }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { results: unknown[] }).results, []);
    assert.equal((await fetch(`${base}/v1/documents/refunds`, { method: 'DELETE', headers })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('Ollama adapter checks the actual HTTP response schema', async () => {
  let valid = true; let sent: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    sent = JSON.parse(body) as Record<string, unknown>;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ embeddings: valid ? [[1, 0]] : [[0, 0]] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = createOllama(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'local', '', 1000);
  try {
    assert.deepEqual(await client.embed(['text']), [[1, 0]]);
    assert.equal(sent.truncate, false);
    assert.deepEqual(sent.input, ['text']);
    valid = false;
    await assert.rejects(client.embed(['text']), /norma/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('an Ollama context rejection leaves the previous document intact', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'input length exceeds the context length' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { store, service } = fixture();
  try {
    await service.ingest('a', document);
    const client = createOllama(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'small-context-model', '', 1000);
    const semantic = new SearchService(store, { mode: 'semantic', embeddingModel: 'small-context-model', generationEnabled: false, client });
    await assert.rejects(semantic.ingest('a', { ...document, text: 'replacement outside context' }), { code: 'model_unavailable' });
    assert.equal(store.chunks('a')[0]!.text, document.text);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('Ollama generation uses a bounded deterministic configuration', async () => {
  let sent: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    sent = JSON.parse(body) as Record<string, unknown>;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ response: 'Texto com fonte [manual:0]' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = createOllama(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'embedding', 'generation', 1000);
    const format = { type: 'object', properties: { answer: { type: 'string' } } };
    assert.equal(await client.generate('Responda com citacao.', format), 'Texto com fonte [manual:0]');
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.options, { temperature: 0, seed: 42, num_predict: 512 });
    assert.deepEqual(sent.format, format);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
