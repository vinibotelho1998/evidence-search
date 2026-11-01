import { ApiError } from './errors.ts';

export type ModelClient = {
  embed: (texts: string[]) => Promise<number[][]>;
  generate: (prompt: string, format?: Record<string, unknown>) => Promise<string>;
};

export function createOllama(baseUrl: string, embeddingModel: string, generationModel: string, timeoutMs: number): ModelClient {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('OLLAMA_URL precisa ser HTTP(S).');
  async function request(path: string, body: object): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(new URL(path, base), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('JSON invalido');
      return result as Record<string, unknown>;
    } catch {
      throw new ApiError(502, 'model_unavailable', 'Modelo indisponivel ou resposta invalida. Verifique o servidor Ollama.');
    }
  }
  return {
    async embed(texts) {
      // Reject inputs outside the model context instead of indexing a silently truncated text.
      const data = await request('/api/embed', { model: embeddingModel, input: texts, truncate: false });
      const vectors = data.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(vector =>
        Array.isArray(vector) && vector.length && vector.every(value => typeof value === 'number' && Number.isFinite(value)))) {
        throw new ApiError(502, 'invalid_embeddings', 'O provedor retornou embeddings invalidos.');
      }
      const result = vectors as number[][];
      if (!result.every(vector => vector.length === result[0]!.length && vector.some(value => value !== 0))) {
        throw new ApiError(502, 'invalid_embeddings', 'Dimensoes ou norma dos embeddings invalidas.');
      }
      return result;
    },
    async generate(prompt, format) {
      if (!generationModel) throw new ApiError(409, 'generation_disabled', 'Defina GENERATION_MODEL para habilitar respostas geradas.');
      const data = await request('/api/generate', { model: generationModel, prompt, stream: false,
        ...(format ? { format } : {}),
        options: { temperature: 0, seed: 42, num_predict: 512 } });
      if (typeof data.response !== 'string' || !data.response.trim()) throw new ApiError(502, 'invalid_generation', 'Resposta vazia do modelo.');
      return data.response;
    },
  };
}
