// Vector memory store for recalling past solutions
// Note: SqlStorage import removed - using in-memory store for now

export interface VectorEntry {
  id: string;
  task: string;
  solution: string;
  embedding: number[];
  createdAt: number;
}

// Simple in-memory vector store (will persist to SQLite later)
const vectorStore: VectorEntry[] = [];

// Simple cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Simple hash-based embedding (placeholder for real embeddings)
function simpleEmbedding(text: string): number[] {
  const vector = new Array(128).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const char = word.charCodeAt(i);
      vector[char % 128] += 1;
    }
  }
  // Normalize
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vector.map(v => v / norm) : vector;
}

export function storeSolution(task: string, solution: string): void {
  const entry: VectorEntry = {
    id: crypto.randomUUID(),
    task,
    solution,
    embedding: simpleEmbedding(task),
    createdAt: Date.now()
  };
  vectorStore.push(entry);
  
  // Keep only recent 100 entries
  while (vectorStore.length > 100) {
    vectorStore.shift();
  }
}

export function findSimilarSolutions(task: string, threshold = 0.7): VectorEntry[] {
  const queryEmbedding = simpleEmbedding(task);
  
  const results = vectorStore
    .map(entry => ({
      entry,
      similarity: cosineSimilarity(queryEmbedding, entry.embedding)
    }))
    .filter(r => r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3)
    .map(r => r.entry);
  
  return results;
}

export function getMemoryStats(): { total: number; recent: number } {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return {
    total: vectorStore.length,
    recent: vectorStore.filter(e => e.createdAt > oneDayAgo).length
  };
}
