import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentStore } from './store.ts';
import { SearchService } from './search.ts';
import { createOllama } from './ollama.ts';
import { createApp } from './http.ts';

const dataDir = process.env.DATA_DIR ?? 'var';
mkdirSync(dataDir, { recursive: true });
const keys: unknown = JSON.parse(process.env.API_KEYS_JSON ?? '{}');
if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.entries(keys).length ||
  !Object.entries(keys).every(([key, tenant]) => key.length >= 8 && typeof tenant === 'string' && tenant.length > 0)) {
  throw new Error('Defina API_KEYS_JSON com chaves de pelo menos 8 caracteres e equipes nao vazias. Veja .env.example.');
}
const mode = process.env.SEARCH_MODE ?? 'lexical';
if (!['lexical', 'semantic'].includes(mode)) throw new Error('SEARCH_MODE deve ser lexical ou semantic.');
const embeddingModel = process.env.EMBEDDING_MODEL ?? 'embeddinggemma';
const generationModel = process.env.GENERATION_MODEL ?? '';
const timeout = Number(process.env.REQUEST_TIMEOUT_MS ?? 15_000);
const port = Number(process.env.PORT ?? 8004);
if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Timeout ou porta invalidos.');
const store = new DocumentStore(join(dataDir, 'documents.sqlite'));
const service = new SearchService(store, { mode: mode as 'lexical' | 'semantic', embeddingModel,
  generationEnabled: Boolean(generationModel), client: createOllama(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', embeddingModel, generationModel, timeout) });
const server = createApp(service, keys as Record<string, string>);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Evidence Search: http://${process.env.HOST ?? '127.0.0.1'}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
