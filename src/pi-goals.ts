// Goal-driven autonomous planning for Blob
// Agent sets its own objectives based on context

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  status: "active" | "completed" | "abandoned";
  createdAt: number;
  completedAt?: number;
  parentGoalId?: string;
  subGoals?: string[];
  context: {
    trigger: string;
    source: string;
    relatedFiles?: string[];
  };
}

export interface GoalProgress {
  goalId: string;
  steps: Array<{
    description: string;
    completed: boolean;
    timestamp: number;
  }>;
  currentStep: number;
  notes: string[];
}

// Goal manager for autonomous planning
export class GoalManager {
  constructor(private db: SqlStorage) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        parent_goal_id TEXT,
        context TEXT NOT NULL, -- JSON
        FOREIGN KEY (parent_goal_id) REFERENCES goals(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_progress (
        goal_id TEXT PRIMARY KEY,
        steps TEXT NOT NULL, -- JSON array
        current_step INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL, -- JSON array
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_goals_priority ON goals(priority)
    `);
  }

  // Create a new goal
  createGoal(
    title: string,
    description: string,
    priority: Goal["priority"],
    context: Goal["context"],
    parentGoalId?: string
  ): Goal {
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();

    this.db.exec(`
      INSERT INTO goals (id, title, description, priority, status, created_at, parent_goal_id, context)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `, id, title, description, priority, now, parentGoalId || null, JSON.stringify(context));

    // Initialize progress tracking
    this.db.exec(`
      INSERT INTO goal_progress (goal_id, steps, current_step, notes, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `, id, JSON.stringify([]), JSON.stringify([]), now);

    return {
      id,
      title,
      description,
      priority,
      status: "active",
      createdAt: now,
      parentGoalId,
      context
    };
  }

  // Get active goals sorted by priority
  getActiveGoals(): Goal[] {
    const result = this.db.exec(`
      SELECT * FROM goals
      WHERE status = 'active'
      ORDER BY 
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at ASC
    `);

    return result.toArray().map(row => this.rowToGoal(row));
  }

  // Get goal by ID
  getGoal(id: string): Goal | null {
    const result = this.db.exec(`
      SELECT * FROM goals WHERE id = ?
    `, id);

    const rows = result.toArray();
    if (rows.length === 0) return null;
    return this.rowToGoal(rows[0]);
  }

  // Complete a goal
  completeGoal(id: string, notes?: string): void {
    const now = Date.now();
    
    this.db.exec(`
      UPDATE goals
      SET status = 'completed', completed_at = ?
      WHERE id = ?
    `, now, id);

    if (notes) {
      this.addProgressNote(id, notes);
    }
  }

  // Abandon a goal
  abandonGoal(id: string, reason: string): void {
    this.db.exec(`
      UPDATE goals
      SET status = 'abandoned'
      WHERE id = ?
    `, id);

    this.addProgressNote(id, `Abandoned: ${reason}`);
  }

  // Add progress step
  addProgressStep(goalId: string, description: string): void {
    const progress = this.getProgress(goalId);
    if (!progress) return;

    progress.steps.push({
      description,
      completed: false,
      timestamp: Date.now()
    });

    this.db.exec(`
      UPDATE goal_progress
      SET steps = ?, updated_at = ?
      WHERE goal_id = ?
    `, JSON.stringify(progress.steps), Date.now(), goalId);
  }

  // Complete current step
  completeStep(goalId: string, notes?: string): void {
    const progress = this.getProgress(goalId);
    if (!progress) return;

    if (progress.currentStep < progress.steps.length) {
      progress.steps[progress.currentStep].completed = true;
      progress.currentStep++;
    }

    this.db.exec(`
      UPDATE goal_progress
      SET steps = ?, current_step = ?, updated_at = ?
      WHERE goal_id = ?
    `, JSON.stringify(progress.steps), progress.currentStep, Date.now(), goalId);

    if (notes) {
      this.addProgressNote(goalId, notes);
    }
  }

  // Add note to progress
  addProgressNote(goalId: string, note: string): void {
    const progress = this.getProgress(goalId);
    if (!progress) return;

    progress.notes.push(note);

    this.db.exec(`
      UPDATE goal_progress
      SET notes = ?, updated_at = ?
      WHERE goal_id = ?
    `, JSON.stringify(progress.notes), Date.now(), goalId);
  }

  // Get progress for a goal
  getProgress(goalId: string): GoalProgress | null {
    const result = this.db.exec(`
      SELECT * FROM goal_progress WHERE goal_id = ?
    `, goalId);

    const rows = result.toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      goalId: String(row.goal_id),
      steps: JSON.parse(String(row.steps)),
      currentStep: Number(row.current_step),
      notes: JSON.parse(String(row.notes))
    };
  }

  // Get goal statistics
  getStats(): { active: number; completed: number; abandoned: number; total: number } {
    const result = this.db.exec(`
      SELECT 
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as abandoned,
        COUNT(*) as total
      FROM goals
    `);

    const row = result.toArray()[0];
    return {
      active: Number(row.active) || 0,
      completed: Number(row.completed) || 0,
      abandoned: Number(row.abandoned) || 0,
      total: Number(row.total) || 0
    };
  }

  private rowToGoal(row: Record<string, unknown>): Goal {
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      priority: String(row.priority) as Goal["priority"],
      status: String(row.status) as Goal["status"],
      createdAt: Number(row.created_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      parentGoalId: row.parent_goal_id ? String(row.parent_goal_id) : undefined,
      context: JSON.parse(String(row.context))
    };
  }
}

// SqlStorage type
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};
