import { DatabaseSync } from 'node:sqlite';
import type { TextChunk } from './text.ts';

export type StoredChunk = TextChunk & { title: string; source: string; vector: number[] | null; embeddingModel: string | null };

export class DocumentStore {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (
        tenant TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
        PRIMARY KEY(tenant, id));
      CREATE TABLE IF NOT EXISTS chunks (
        tenant TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, text TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, vector TEXT, embedding_model TEXT,
        PRIMARY KEY(tenant, id),
        FOREIGN KEY(tenant, document_id) REFERENCES documents(tenant, id) ON DELETE CASCADE);`);
  }
  replace(tenant: string, document: { id: string; title: string; source: string }, chunks: TextChunk[], vectors: number[][] | null, model: string | null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM documents WHERE tenant = ? AND id = ?').run(tenant, document.id);
      this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?)').run(tenant, document.id, document.title, document.source);
      const statement = this.db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      chunks.forEach((chunk, index) => statement.run(tenant, chunk.id, chunk.documentId, chunk.text,
        chunk.startLine, chunk.endLine, vectors ? JSON.stringify(vectors[index]) : null, model));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  chunks(tenant: string): StoredChunk[] {
    const rows = this.db.prepare(`SELECT c.*, d.title, d.source FROM chunks c JOIN documents d
      ON d.tenant = c.tenant AND d.id = c.document_id WHERE c.tenant = ? ORDER BY c.id`).all(tenant);
    return rows.map(row => ({ id: String(row.id), documentId: String(row.document_id), text: String(row.text),
      startLine: Number(row.start_line), endLine: Number(row.end_line), title: String(row.title), source: String(row.source),
      vector: row.vector ? JSON.parse(String(row.vector)) as number[] : null,
      embeddingModel: row.embedding_model ? String(row.embedding_model) : null }));
  }
  delete(tenant: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM documents WHERE tenant = ? AND id = ?').run(tenant, id).changes) > 0;
  }
  close() { this.db.close(); }
}
