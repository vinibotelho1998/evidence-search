import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.ts';
import { SearchService } from './search.ts';

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    const buffer = Buffer.from(part as Uint8Array);
    bytes += buffer.length;
    if (bytes > 150_000) throw new ApiError(413, 'body_too_large', 'Limite de 150 KB por requisicao.');
    parts.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_json', 'Envie um objeto JSON valido.'); }
}

function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'invalid_input', `Campo ${key}: texto obrigatorio, ate ${max} caracteres.`);
  return value.trim();
}

export function createApp(service: SearchService, apiKeys: Record<string, string>) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    const send = (status: number, data: unknown) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') { send(200, { status: 'ok', mode: service.options.mode }); return; }
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const tenant = Object.hasOwn(apiKeys, token) ? apiKeys[token] : undefined;
      if (!tenant) throw new ApiError(401, 'unauthorized', 'Bearer token ausente ou invalido.');
      if (request.method === 'POST' && url.pathname === '/v1/documents') {
        const body = await readJson(request);
        const id = text(body, 'id', 80);
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ApiError(400, 'invalid_id', 'id aceita letras, numeros, _ e -.');
        send(201, await service.ingest(tenant, { id, title: text(body, 'title', 200), source: text(body, 'source', 500), text: text(body, 'text', 100_000) })); return;
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/documents/')) {
        const removed = service.store.delete(tenant, decodeURIComponent(url.pathname.slice('/v1/documents/'.length)));
        if (!removed) throw new ApiError(404, 'not_found', 'Documento nao encontrado.');
        send(200, { deleted: true }); return;
      }
      if (request.method === 'POST' && ['/v1/search', '/v1/answer'].includes(url.pathname)) {
        const body = await readJson(request);
        const query = text(body, 'query', 2_000);
        const topK = body.topK ?? 5;
        if (!Number.isInteger(topK) || Number(topK) < 1 || Number(topK) > 20) throw new ApiError(400, 'invalid_top_k', 'topK precisa ser inteiro entre 1 e 20.');
        send(200, url.pathname === '/v1/search' ? { mode: service.options.mode, results: await service.search(tenant, query, Number(topK)) } : await service.answer(tenant, query)); return;
      }
      throw new ApiError(404, 'not_found', 'Rota nao encontrada.');
    } catch (error) {
      const known = error instanceof ApiError;
      send(known ? error.status : 500, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Falha interna.', requestId } });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
