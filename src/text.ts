export type TextChunk = { id: string; documentId: string; text: string; startLine: number; endLine: number };

const stopwords = new Set('a o as os de da do das dos e em para por com um uma que no na nos nas se qual como'.split(' '));

export function tokenize(text: string): string[] {
  return (text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length > 1 && !stopwords.has(word));
}

// Preserve the source lines instead of claiming page numbers that the importer never read.
export function chunkText(documentId: string, text: string, maxChars = 650): TextChunk[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  let startLine = 1;
  const flush = (endLine: number) => {
    const content = buffer.join('\n').trim();
    if (content) chunks.push({ id: `${documentId}:${chunks.length}`, documentId, text: content, startLine, endLine });
    buffer = [];
  };
  for (const [index, line] of lines.entries()) {
    if (buffer.length && buffer.join('\n').length + line.length > maxChars) {
      flush(index);
      startLine = index + 1;
    }
    if (!buffer.length) startLine = index + 1;
    // Split long individual lines without losing their original line reference.
    for (let offset = 0; offset < Math.max(line.length, 1); offset += maxChars) {
      if (offset) { flush(index + 1); startLine = index + 1; }
      buffer.push(line.slice(offset, offset + maxChars));
    }
  }
  flush(lines.length);
  return chunks;
}

export function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) throw new Error('Dimensoes de embeddings incompativeis. Reindexe a base.');
  let product = 0, normLeft = 0, normRight = 0;
  for (let i = 0; i < left.length; i++) {
    product += left[i]! * right[i]!;
    normLeft += left[i]! ** 2;
    normRight += right[i]! ** 2;
  }
  return normLeft && normRight ? product / Math.sqrt(normLeft * normRight) : 0;
}

export function bm25(query: string, texts: string[]): number[] {
  const documents = texts.map(tokenize);
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
  return documents.map(tokens => {
    let score = 0;
    for (const term of new Set(tokenize(query))) {
      const frequency = tokens.filter(token => token === term).length;
      if (!frequency) continue;
      const documentFrequency = documents.filter(doc => doc.includes(term)).length;
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += idf * (frequency * 2.5) / (frequency + 1.5 * (0.25 + 0.75 * tokens.length / (averageLength || 1)));
    }
    return score;
  });
}
