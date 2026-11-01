import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { DocumentStore } from '../src/store.ts';
import { SearchService } from '../src/search.ts';
import { createOllama } from '../src/ollama.ts';
const semantic = process.env.SEARCH_MODE === 'semantic';
const store = new DocumentStore(':memory:');
const model = process.env.EMBEDDING_MODEL ?? 'embeddinggemma';
const service = new SearchService(store, { mode: semantic ? 'semantic' : 'lexical', embeddingModel: model, generationEnabled: false,
  client: createOllama(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', model, '', 15_000) });
try {
  const corpus = JSON.parse(await readFile(new URL('../data/corpus.json', import.meta.url), 'utf8')) as {id:string;title:string;source:string;text:string}[];
  const questions = JSON.parse(await readFile(new URL('../data/questions.json', import.meta.url), 'utf8')) as {query:string;relevantDocument:string}[];
  for (const document of corpus) await service.ingest('evaluation', document);
  const cases = [];
  for (const question of questions) {
    const started = performance.now();
    const hits = await service.search('evaluation', question.query, 3);
    const rank = hits.findIndex(hit => hit.documentId === question.relevantDocument) + 1;
    cases.push({ ...question, retrieved: hits.map(hit => hit.documentId), rank, latencyMs: performance.now() - started });
  }
  const report = { corpus: 'manual ficticio autoral; 6 documentos / 12 perguntas', mode: service.options.mode,
    embeddingModel: semantic ? model : null, recallAt3: cases.filter(item => item.rank > 0).length / cases.length,
    meanReciprocalRankAt3: cases.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / cases.length,
    warning: 'Conjunto pequeno escrito junto ao corpus: smoke benchmark, nao prova generalizacao. Geracao nao avaliada.', cases };
  await mkdir('var', { recursive: true });
  await writeFile('var/evaluation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }
