import { readFile } from 'node:fs/promises';
import { DocumentStore } from '../src/store.ts';
import { SearchService } from '../src/search.ts';
const store = new DocumentStore(':memory:');
const service = new SearchService(store, { mode: 'lexical', embeddingModel: '', generationEnabled: false,
  client: { embed: async () => { throw new Error('Nao usado no modo lexical'); }, generate: async () => '' } });
try {
  const corpus = JSON.parse(await readFile(new URL('../data/corpus.json', import.meta.url), 'utf8')) as {id:string;title:string;source:string;text:string}[];
  for (const document of corpus) await service.ingest('demo', document);
  console.log(JSON.stringify(await service.answer('demo', 'como solicitar reembolsos de despesas?'), null, 2));
} finally { store.close(); }
