// Proactive suggestion system for Blob
// Analyzes context and suggests actions before being asked

export interface Suggestion {
  id: string;
  type: "improvement" | "warning" | "opportunity" | "reminder";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  suggestedAction: string;
  context: {
    trigger: string;
    relatedFiles?: string[];
    relatedGoals?: string[];
    confidence: number; // 0-1
  };
  status: "pending" | "accepted" | "dismissed" | "implemented";
  createdAt: number;
  dismissedAt?: number;
  implementedAt?: number;
}

// Proactive suggestion engine
export class SuggestionEngine {
  private suggestionHandlers: Array<(context: SuggestionContext) => Suggestion | null> = [];

  constructor(private db: SqlStorage) {
    this.initSchema();
    this.registerDefaultHandlers();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        context TEXT NOT NULL, -- JSON
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        dismissed_at INTEGER,
        implemented_at INTEGER
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_suggestions_priority ON suggestions(priority)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at)
    `);
  }

  // Register default suggestion handlers
  private registerDefaultHandlers(): void {
    // Handler: Suggest tests when code is modified
    this.suggestionHandlers.push((ctx) => {
      if (ctx.recentChanges.some(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
        const testFile = ctx.recentChanges.find(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
        if (testFile && !ctx.existingFiles.includes(testFile.replace('.ts', '.test.ts'))) {
          return {
            id: ``,
            type: "improvement",
            priority: "medium",
            title: "Add tests for modified code",
            description: `You modified ${testFile} but there's no corresponding test file.`,
            suggestedAction: `Create ${testFile.replace('.ts', '.test.ts')} with unit tests`,
            context: {
              trigger: "code_modification",
              relatedFiles: [testFile],
              confidence: 0.8
            },
            status: "pending",
            createdAt: Date.now()
          };
        }
      }
      return null;
    });

    // Handler: Suggest documentation updates
    this.suggestionHandlers.push((ctx) => {
      if (ctx.recentChanges.includes('README.md') || ctx.recentChanges.some(f => f.endsWith('.md'))) {
        return null; // Already updated docs
      }
      
      const hasNewFeatures = ctx.recentCommits?.some(c => 
        /add|feature|implement/i.test(c)
      );
      
      if (hasNewFeatures) {
        return {
          id: ``,
          type: "reminder",
          priority: "low",
          title: "Update documentation",
          description: "Recent commits suggest new features. Consider updating README.md",
          suggestedAction: "Review and update README.md with new features",
          context: {
            trigger: "new_features",
            confidence: 0.6
          },
          status: "pending",
          createdAt: Date.now()
        };
      }
      return null;
    });

    // Handler: Suggest refactoring for large files
    this.suggestionHandlers.push((ctx) => {
      const largeFiles = ctx.fileMetrics?.filter(f => f.lines > 500) || [];
      if (largeFiles.length > 0) {
        const file = largeFiles[0];
        return {
          id: ``,
          type: "improvement",
          priority: "low",
          title: `Consider refactoring ${file.name}`,
          description: `${file.name} has ${file.lines} lines. Consider breaking it into smaller modules.`,
          suggestedAction: `Refactor ${file.name} into smaller, focused modules`,
          context: {
            trigger: "large_file",
            relatedFiles: [file.name],
            confidence: 0.5
          },
          status: "pending",
          createdAt: Date.now()
        };
      }
      return null;
    });

    // Handler: Suggest dependency updates
    this.suggestionHandlers.push((ctx) => {
      if (ctx.outdatedDependencies && ctx.outdatedDependencies.length > 0) {
        const deps = ctx.outdatedDependencies.slice(0, 3);
        return {
          id: ``,
          type: "opportunity",
          priority: "medium",
          title: "Update dependencies",
          description: `${ctx.outdatedDependencies.length} dependencies are outdated: ${deps.join(', ')}`,
          suggestedAction: "Run npm update and test",
          context: {
            trigger: "outdated_dependencies",
            confidence: 0.7
          },
          status: "pending",
          createdAt: Date.now()
        };
      }
      return null;
    });

    // Handler: Suggest error pattern fixes
    this.suggestionHandlers.push((ctx) => {
      if (ctx.recentErrors && ctx.recentErrors.length >= 3) {
        const pattern = this.findCommonPattern(ctx.recentErrors);
        if (pattern) {
          return {
            id: ``,
            type: "warning",
            priority: "high",
            title: "Recurring error pattern detected",
            description: `Multiple similar errors: ${pattern}`,
            suggestedAction: "Investigate root cause and implement fix",
            context: {
              trigger: "recurring_errors",
              confidence: 0.85
            },
            status: "pending",
            createdAt: Date.now()
          };
        }
      }
      return null;
    });
  }

  // Analyze context and generate suggestions
  analyzeContext(context: SuggestionContext): Suggestion[] {
    const suggestions: Suggestion[] = [];

    for (const handler of this.suggestionHandlers) {
      const suggestion = handler(context);
      if (suggestion) {
        suggestion.id = `suggest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        suggestions.push(suggestion);
      }
    }

    // Store suggestions
    for (const suggestion of suggestions) {
      this.storeSuggestion(suggestion);
    }

    return suggestions;
  }

  // Get pending suggestions
  getPendingSuggestions(limit: number = 10): Suggestion[] {
    const result = this.db.exec(`
      SELECT * FROM suggestions
      WHERE status = 'pending'
      ORDER BY 
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at DESC
      LIMIT ?
    `, limit);

    return result.toArray().map(row => this.rowToSuggestion(row));
  }

  // Get high priority suggestions that need attention
  getUrgentSuggestions(): Suggestion[] {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    
    const result = this.db.exec(`
      SELECT * FROM suggestions
      WHERE status = 'pending'
        AND priority = 'high'
        AND created_at > ?
      ORDER BY created_at DESC
    `, cutoff);

    return result.toArray().map(row => this.rowToSuggestion(row));
  }

  // Accept a suggestion
  acceptSuggestion(id: string): void {
    this.db.exec(`
      UPDATE suggestions
      SET status = 'accepted'
      WHERE id = ?
    `, id);
  }

  // Dismiss a suggestion
  dismissSuggestion(id: string, reason?: string): void {
    this.db.exec(`
      UPDATE suggestions
      SET status = 'dismissed', dismissed_at = ?
      WHERE id = ?
    `, Date.now(), id);
  }

  // Mark as implemented
  markImplemented(id: string): void {
    this.db.exec(`
      UPDATE suggestions
      SET status = 'implemented', implemented_at = ?
      WHERE id = ?
    `, Date.now(), id);
  }

  // Generate proactive message for user
  generateProactiveMessage(): string | null {
    const urgent = this.getUrgentSuggestions();
    if (urgent.length > 0) {
      const s = urgent[0];
      return `🤔 **${s.title}**\n${s.description}\n\n💡 Suggested: ${s.suggestedAction}`;
    }

    const pending = this.getPendingSuggestions(1);
    if (pending.length > 0) {
      const s = pending[0];
      return `💭 **I noticed something**\n${s.description}\n\nWant me to: ${s.suggestedAction}?`;
    }

    return null;
  }

  // Get suggestion statistics
  getStats(): {
    pending: number;
    accepted: number;
    dismissed: number;
    implemented: number;
    total: number;
  } {
    const result = this.db.exec(`
      SELECT 
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
        SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed,
        SUM(CASE WHEN status = 'implemented' THEN 1 ELSE 0 END) as implemented,
        COUNT(*) as total
      FROM suggestions
    `);

    const row = result.toArray()[0];
    return {
      pending: Number(row.pending) || 0,
      accepted: Number(row.accepted) || 0,
      dismissed: Number(row.dismissed) || 0,
      implemented: Number(row.implemented) || 0,
      total: Number(row.total) || 0
    };
  }

  private storeSuggestion(suggestion: Suggestion): void {
    this.db.exec(`
      INSERT INTO suggestions 
        (id, type, priority, title, description, suggested_action, context, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, suggestion.id, suggestion.type, suggestion.priority, suggestion.title,
       suggestion.description, suggestion.suggestedAction, JSON.stringify(suggestion.context),
       suggestion.status, suggestion.createdAt);
  }

  private findCommonPattern(errors: string[]): string | null {
    // Simple pattern detection - find common substring
    if (errors.length < 2) return null;
    
    // Look for common error types
    const patterns = [
      /TypeError:.*is not a function/i,
      /Cannot read propert.*of undefined/i,
      /ENOENT:.*no such file/i,
      /ECONNREFUSED/i,
      /timeout/i
    ];

    for (const pattern of patterns) {
      const matches = errors.filter(e => pattern.test(e));
      if (matches.length >= 2) {
        return pattern.source;
      }
    }

    return null;
  }

  private rowToSuggestion(row: Record<string, unknown>): Suggestion {
    return {
      id: String(row.id),
      type: String(row.type) as Suggestion["type"],
      priority: String(row.priority) as Suggestion["priority"],
      title: String(row.title),
      description: String(row.description),
      suggestedAction: String(row.suggested_action),
      context: JSON.parse(String(row.context)),
      status: String(row.status) as Suggestion["status"],
      createdAt: Number(row.created_at),
      dismissedAt: row.dismissed_at ? Number(row.dismissed_at) : undefined,
      implementedAt: row.implemented_at ? Number(row.implemented_at) : undefined
    };
  }
}

// Context for suggestion analysis
export interface SuggestionContext {
  recentChanges: string[];
  existingFiles: string[];
  recentCommits?: string[];
  fileMetrics?: Array<{ name: string; lines: number }>;
  outdatedDependencies?: string[];
  recentErrors?: string[];
  currentGoals?: string[];
}

// SqlStorage type
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};
