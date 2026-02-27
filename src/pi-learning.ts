// Continuous learning system for Blob
// Analyzes past interactions to improve future performance

export interface LearningEntry {
  id: string;
  type: "success" | "failure" | "pattern" | "insight";
  category: string;
  description: string;
  context: {
    sessionId: string;
    timestamp: number;
    relatedFiles?: string[];
    command?: string;
    error?: string;
  };
  lesson: string;
  application: string; // How to apply this learning
  appliedCount: number;
  lastApplied?: number;
}

export interface Pattern {
  id: string;
  pattern: string; // Regex or description
  category: string;
  frequency: number;
  lastSeen: number;
  suggestedAction?: string;
}

// Continuous learning system
export class LearningSystem {
  constructor(private db: SqlStorage) {
    this.initSchema();
  }

  private initSchema(): void {
    // Learning entries - lessons learned from interactions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        context TEXT NOT NULL, -- JSON
        lesson TEXT NOT NULL,
        application TEXT NOT NULL,
        applied_count INTEGER NOT NULL DEFAULT 0,
        last_applied INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    // Pattern recognition - recurring patterns in user behavior
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        category TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        suggested_action TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    // Interaction history for analysis
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interaction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        success BOOLEAN NOT NULL,
        duration_ms INTEGER,
        error_message TEXT,
        tool_calls TEXT -- JSON array of tools used
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_learning_category ON learning_entries(category)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_learning_type ON learning_entries(type)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_interactions_session ON interaction_history(session_id)
    `);
  }

  // Record an interaction for later analysis
  recordInteraction(
    sessionId: string,
    input: string,
    output: string,
    success: boolean,
    durationMs?: number,
    errorMessage?: string,
    toolCalls?: string[]
  ): void {
    this.db.exec(`
      INSERT INTO interaction_history 
        (session_id, input, output, success, duration_ms, error_message, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, sessionId, input, output, success ? 1 : 0, durationMs || null, errorMessage || null, 
       toolCalls ? JSON.stringify(toolCalls) : null);

    // Analyze for patterns
    this.analyzeInputPattern(input);
  }

  // Learn from a successful interaction
  learnSuccess(
    category: string,
    description: string,
    context: LearningEntry["context"],
    lesson: string,
    application: string
  ): void {
    this.createLearningEntry("success", category, description, context, lesson, application);
  }

  // Learn from a failure
  learnFailure(
    category: string,
    description: string,
    context: LearningEntry["context"],
    lesson: string,
    application: string
  ): void {
    this.createLearningEntry("failure", category, description, context, lesson, application);
  }

  // Record an insight
  recordInsight(
    category: string,
    description: string,
    context: LearningEntry["context"],
    lesson: string,
    application: string
  ): void {
    this.createLearningEntry("insight", category, description, context, lesson, application);
  }

  // Get relevant learnings for a context
  getRelevantLearnings(category: string, limit: number = 5): LearningEntry[] {
    const result = this.db.exec(`
      SELECT * FROM learning_entries
      WHERE category = ?
      ORDER BY applied_count DESC, created_at DESC
      LIMIT ?
    `, category, limit);

    return result.toArray().map(row => this.rowToLearningEntry(row));
  }

  // Get learnings that haven't been applied recently
  getStaleLearnings(days: number = 7, limit: number = 10): LearningEntry[] {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    
    const result = this.db.exec(`
      SELECT * FROM learning_entries
      WHERE (last_applied IS NULL OR last_applied < ?)
        AND type IN ('success', 'insight')
      ORDER BY applied_count ASC, created_at DESC
      LIMIT ?
    `, cutoff, limit);

    return result.toArray().map(row => this.rowToLearningEntry(row));
  }

  // Mark a learning as applied
  markApplied(id: string): void {
    this.db.exec(`
      UPDATE learning_entries
      SET applied_count = applied_count + 1, last_applied = ?
      WHERE id = ?
    `, Date.now(), id);
  }

  // Get recognized patterns
  getPatterns(category?: string, minFrequency: number = 3): Pattern[] {
    let query = `
      SELECT * FROM patterns
      WHERE frequency >= ?
    `;
    const params: (number | string)[] = [minFrequency];

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    query += ` ORDER BY frequency DESC, last_seen DESC`;

    const result = this.db.exec(query, ...params);
    return result.toArray().map(row => ({
      id: String(row.id),
      pattern: String(row.pattern),
      category: String(row.category),
      frequency: Number(row.frequency),
      lastSeen: Number(row.last_seen),
      suggestedAction: row.suggested_action ? String(row.suggested_action) : undefined
    }));
  }

  // Analyze recent interactions for new patterns
  analyzeRecentInteractions(hours: number = 24): void {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    
    const result = this.db.exec(`
      SELECT input, COUNT(*) as count
      FROM interaction_history
      WHERE timestamp > ?
      GROUP BY input
      HAVING count >= 3
      ORDER BY count DESC
    `, cutoff);

    for (const row of result.toArray()) {
      this.recordPattern(String(row.input), "frequent_command", Number(row.count));
    }
  }

  // Generate learning summary
  generateSummary(): string {
    const stats = this.getStats();
    const recentPatterns = this.getPatterns(undefined, 2).slice(0, 5);
    
    let summary = `📚 Learning Summary\n`;
    summary += `Total entries: ${stats.totalEntries}\n`;
    summary += `Success patterns: ${stats.successCount}\n`;
    summary += `Failure patterns: ${stats.failureCount}\n`;
    summary += `Insights: ${stats.insightCount}\n\n`;
    
    if (recentPatterns.length > 0) {
      summary += `Recognized patterns:\n`;
      for (const pattern of recentPatterns) {
        summary += `  • ${pattern.pattern.slice(0, 50)}... (${pattern.frequency}x)\n`;
      }
    }
    
    return summary;
  }

  // Get statistics
  getStats(): { 
    totalEntries: number; 
    successCount: number; 
    failureCount: number; 
    insightCount: number;
    patternCount: number;
  } {
    const entriesResult = this.db.exec(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN type = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN type = 'failure' THEN 1 ELSE 0 END) as failure,
        SUM(CASE WHEN type = 'insight' THEN 1 ELSE 0 END) as insight
      FROM learning_entries
    `);

    const patternsResult = this.db.exec(`SELECT COUNT(*) as count FROM patterns`);

    const entryRow = entriesResult.toArray()[0];
    return {
      totalEntries: Number(entryRow.total) || 0,
      successCount: Number(entryRow.success) || 0,
      failureCount: Number(entryRow.failure) || 0,
      insightCount: Number(entryRow.insight) || 0,
      patternCount: Number(patternsResult.toArray()[0].count) || 0
    };
  }

  private createLearningEntry(
    type: LearningEntry["type"],
    category: string,
    description: string,
    context: LearningEntry["context"],
    lesson: string,
    application: string
  ): void {
    const id = `learn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    
    this.db.exec(`
      INSERT INTO learning_entries 
        (id, type, category, description, context, lesson, application, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, id, type, category, description, JSON.stringify(context), lesson, application, Date.now());
  }

  private analyzeInputPattern(input: string): void {
    // Simple pattern detection - could be expanded with ML
    const patterns = [
      { regex: /fix\s+(bug|error|issue)/i, category: "bug_fix" },
      { regex: /add\s+(feature|support|new)/i, category: "feature_addition" },
      { regex: /refactor|cleanup|simplify/i, category: "refactoring" },
      { regex: /test|spec/i, category: "testing" },
      { regex: /deploy|release|publish/i, category: "deployment" }
    ];

    for (const { regex, category } of patterns) {
      if (regex.test(input)) {
        this.recordPattern(regex.source, category, 1);
        break;
      }
    }
  }

  private recordPattern(pattern: string, category: string, frequency: number): void {
    // Check if pattern exists
    const existing = this.db.exec(`
      SELECT id, frequency FROM patterns WHERE pattern = ? AND category = ?
    `, pattern, category);

    const rows = existing.toArray();
    if (rows.length > 0) {
      // Update existing
      this.db.exec(`
        UPDATE patterns
        SET frequency = frequency + ?, last_seen = ?
        WHERE id = ?
      `, frequency, Date.now(), String(rows[0].id));
    } else {
      // Create new
      const id = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.db.exec(`
        INSERT INTO patterns (id, pattern, category, frequency, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `, id, pattern, category, frequency, Date.now());
    }
  }

  private rowToLearningEntry(row: Record<string, unknown>): LearningEntry {
    return {
      id: String(row.id),
      type: String(row.type) as LearningEntry["type"],
      category: String(row.category),
      description: String(row.description),
      context: JSON.parse(String(row.context)),
      lesson: String(row.lesson),
      application: String(row.application),
      appliedCount: Number(row.applied_count) || 0,
      lastApplied: row.last_applied ? Number(row.last_applied) : undefined
    };
  }
}

// SqlStorage type
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};
