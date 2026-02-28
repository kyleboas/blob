import type { Env } from "./types";

interface QueuedMessage {
  id: string;
  role: string;
  content: string;
  type: "steering" | "follow-up";
  timestamp: number;
}

interface SessionBranch {
  id: string;
  parentId: string | null;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  createdAt: number;
}

interface SessionState {
  currentBranchId: string;
  branches: Map<string, SessionBranch>;
  messageQueue: QueuedMessage[];
}

export class SessionManager {
  private state: SessionState;

  constructor() {
    const rootBranch: SessionBranch = {
      id: "root",
      parentId: null,
      messages: [],
      createdAt: Date.now(),
    };
    
    this.state = {
      currentBranchId: "root",
      branches: new Map([["root", rootBranch]]),
      messageQueue: [],
    };
  }

  // Queue a steering message (interrupts current work)
  queueSteeringMessage(content: string): string {
    const id = crypto.randomUUID();
    this.state.messageQueue.push({
      id,
      role: "user",
      content,
      type: "steering",
      timestamp: Date.now(),
    });
    return id;
  }

  // Queue a follow-up message (waits for current work)
  queueFollowUpMessage(content: string): string {
    const id = crypto.randomUUID();
    this.state.messageQueue.push({
      id,
      role: "user",
      content,
      type: "follow-up",
      timestamp: Date.now(),
    });
    return id;
  }

  // Get next message from queue
  dequeueMessage(): QueuedMessage | null {
    // Steering messages have priority
    const steeringIndex = this.state.messageQueue.findIndex(m => m.type === "steering");
    if (steeringIndex >= 0) {
      return this.state.messageQueue.splice(steeringIndex, 1)[0];
    }
    
    // Then follow-up messages
    if (this.state.messageQueue.length > 0) {
      return this.state.messageQueue.shift() || null;
    }
    
    return null;
  }

  // Check if there are steering messages (for interruption)
  hasSteeringMessages(): boolean {
    return this.state.messageQueue.some(m => m.type === "steering");
  }

  // Create a new branch from current position
  createBranch(): string {
    const currentBranch = this.state.branches.get(this.state.currentBranchId);
    if (!currentBranch) throw new Error("Current branch not found");

    const newBranchId = crypto.randomUUID();
    const newBranch: SessionBranch = {
      id: newBranchId,
      parentId: this.state.currentBranchId,
      messages: [...currentBranch.messages],
      createdAt: Date.now(),
    };

    this.state.branches.set(newBranchId, newBranch);
    this.state.currentBranchId = newBranchId;
    return newBranchId;
  }

  // Switch to existing branch
  switchBranch(branchId: string): boolean {
    if (!this.state.branches.has(branchId)) return false;
    this.state.currentBranchId = branchId;
    return true;
  }

  // Get current branch messages
  getCurrentMessages(): Array<{ role: string; content: string; timestamp: number }> {
    const branch = this.state.branches.get(this.state.currentBranchId);
    return branch ? [...branch.messages] : [];
  }

  // Add message to current branch
  addMessage(role: string, content: string): void {
    const branch = this.state.branches.get(this.state.currentBranchId);
    if (branch) {
      branch.messages.push({ role, content, timestamp: Date.now() });
    }
  }

  // Get all branches for tree view
  getBranches(): Array<{ id: string; parentId: string | null; messageCount: number; createdAt: number }> {
    return Array.from(this.state.branches.values()).map(b => ({
      id: b.id,
      parentId: b.parentId,
      messageCount: b.messages.length,
      createdAt: b.createdAt,
    }));
  }

  // Clear queue
  clearQueue(): void {
    this.state.messageQueue = [];
  }
}
