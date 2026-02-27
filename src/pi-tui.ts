// Rich TUI (Terminal UI) Extensions for Pi-style Blob
// Inspired by Armin Ronacher's Pi - spinners, progress bars, tables, file pickers, preview panes

export interface TUIComponent {
  type: TUIComponentType;
  id: string;
  data: unknown;
}

export type TUIComponentType = 
  | "spinner" 
  | "progress" 
  | "table" 
  | "tree" 
  | "status" 
  | "divider"
  | "filepicker"
  | "preview"
  | "diff"
  | "question"
  | "milestone";

export interface SpinnerData {
  message: string;
  status?: "running" | "success" | "error" | "warning";
  elapsed?: number; // milliseconds
}

export interface ProgressData {
  current: number;
  total: number;
  message?: string;
  eta?: string;
}

export interface TableData {
  headers: string[];
  rows: string[][];
  footer?: string;
}

export interface TreeData {
  label: string;
  children?: TreeData[];
  status?: "pending" | "running" | "done" | "error" | "warning";
  details?: string;
}

export interface FilePickerData {
  path: string;
  files: Array<{
    name: string;
    type: "file" | "dir";
    size?: string;
    modified?: string;
    selected?: boolean;
  }>;
}

export interface PreviewData {
  title: string;
  content: string;
  language?: string;
  lineNumbers?: boolean;
}

export interface DiffData {
  file: string;
  additions: number;
  deletions: number;
  hunks: Array<{
    oldStart: number;
    newStart: number;
    lines: Array<{ type: "context" | "add" | "remove"; text: string }>;
  }>;
}

export interface QuestionData {
  questions: Array<{
    id: string;
    text: string;
    type: "text" | "choice" | "confirm";
    choices?: string[];
    default?: string;
  }>;
}

export interface MilestoneData {
  title: string;
  items: Array<{
    label: string;
    status: "pending" | "running" | "done" | "error";
    details?: string;
  }>;
}

// TUI Renderer - converts components to terminal output
export class TUIRenderer {
  private components = new Map<string, TUIComponent>();
  private outputBuffer: string[] = [];
  
  setComponent(component: TUIComponent): void {
    this.components.set(component.id, component);
  }
  
  removeComponent(id: string): void {
    this.components.delete(id);
  }
  
  render(): string {
    this.outputBuffer = [];
    
    for (const component of this.components.values()) {
      this.renderComponent(component);
    }
    
    return this.outputBuffer.join("\n");
  }
  
  private renderComponent(component: TUIComponent): void {
    switch (component.type) {
      case "spinner":
        this.renderSpinner(component.data as SpinnerData);
        break;
      case "progress":
        this.renderProgress(component.data as ProgressData);
        break;
      case "table":
        this.renderTable(component.data as TableData);
        break;
      case "tree":
        this.renderTree(component.data as TreeData, 0);
        break;
      case "status":
        this.renderStatus(component.data as { message: string; type: "info" | "success" | "error" | "warning" });
        break;
      case "divider":
        this.outputBuffer.push("─".repeat(60));
        break;
      case "filepicker":
        this.renderFilePicker(component.data as FilePickerData);
        break;
      case "preview":
        this.renderPreview(component.data as PreviewData);
        break;
      case "diff":
        this.renderDiff(component.data as DiffData);
        break;
      case "question":
        this.renderQuestions(component.data as QuestionData);
        break;
      case "milestone":
        this.renderMilestone(component.data as MilestoneData);
        break;
    }
  }
  
  private renderSpinner(data: SpinnerData): void {
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const icons = {
      running: spinners[Math.floor(Date.now() / 100) % spinners.length],
      success: "✓",
      error: "✗",
      warning: "⚠"
    };
    
    const elapsed = data.elapsed ? ` (${this.formatElapsed(data.elapsed)})` : "";
    this.outputBuffer.push(`${icons[data.status || "running"]} ${data.message}${elapsed}`);
  }
  
  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
  
  private renderProgress(data: ProgressData): void {
    const width = 30;
    const percent = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
    const filled = Math.round((percent / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    
    let line = `${bar} ${percent}% (${data.current}/${data.total})`;
    if (data.message) line += ` ${data.message}`;
    if (data.eta) line += ` [ETA: ${data.eta}]`;
    
    this.outputBuffer.push(line);
  }
  
  private renderTable(data: TableData): void {
    if (data.headers.length === 0 || data.rows.length === 0) return;
    
    // Calculate column widths
    const widths = data.headers.map((h, i) => {
      const maxDataWidth = Math.max(...data.rows.map(r => (r[i] || "").length));
      return Math.max(h.length, maxDataWidth, 8);
    });
    
    // Render header
    const headerRow = data.headers.map((h, i) => h.padEnd(widths[i])).join(" │ ");
    this.outputBuffer.push(headerRow);
    this.outputBuffer.push(widths.map(w => "─".repeat(w)).join("─┼─"));
    
    // Render rows
    for (const row of data.rows) {
      const formattedRow = row.map((cell, i) => (cell || "").padEnd(widths[i])).join(" │ ");
      this.outputBuffer.push(formattedRow);
    }
    
    if (data.footer) {
      this.outputBuffer.push(widths.map(w => "─".repeat(w)).join("─┴─"));
      this.outputBuffer.push(data.footer);
    }
  }
  
  private renderTree(data: TreeData, depth: number): void {
    const indent = "  ".repeat(depth);
    const icons = {
      pending: "○",
      running: "◐",
      done: "✓",
      error: "✗",
      warning: "⚠"
    };
    
    const icon = icons[data.status || "pending"];
    let line = `${indent}${icon} ${data.label}`;
    if (data.details) line += ` ${data.details}`;
    
    this.outputBuffer.push(line);
    
    if (data.children) {
      for (const child of data.children) {
        this.renderTree(child, depth + 1);
      }
    }
  }
  
  private renderFilePicker(data: FilePickerData): void {
    this.outputBuffer.push(`📁 ${data.path}`);
    this.outputBuffer.push("─".repeat(40));
    
    for (const file of data.files) {
      const icon = file.type === "dir" ? "📂" : "📄";
      const selected = file.selected ? "▸ " : "  ";
      let line = `${selected}${icon} ${file.name}`;
      if (file.size) line += ` (${file.size})`;
      if (file.modified) line += ` ${file.modified}`;
      this.outputBuffer.push(line);
    }
  }
  
  private renderPreview(data: PreviewData): void {
    const lang = data.language ? ` ${data.language}` : "";
    this.outputBuffer.push(`┌─ ${data.title}${lang} ${"─".repeat(40 - data.title.length - lang.length)}`);
    
    const lines = data.content.split("\n").slice(0, 20); // Limit to 20 lines
    for (let i = 0; i < lines.length; i++) {
      const lineNum = data.lineNumbers ? String(i + 1).padStart(3) + " │ " : "";
      this.outputBuffer.push(`│ ${lineNum}${lines[i].slice(0, 80)}`);
    }
    
    if (data.content.split("\n").length > 20) {
      this.outputBuffer.push(`│ ... (${data.content.split("\n").length - 20} more lines)`);
    }
    
    this.outputBuffer.push("└" + "─".repeat(50));
  }
  
  private renderDiff(data: DiffData): void {
    const summary = `+${data.additions}/-${data.deletions}`;
    this.outputBuffer.push(`┌─ ${data.file} (${summary}) ${"─".repeat(30)}`);
    
    for (const hunk of data.hunks) {
      this.outputBuffer.push(`│ @@ -${hunk.oldStart}, +${hunk.newStart} @@`);
      for (const line of hunk.lines) {
        const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        this.outputBuffer.push(`│${prefix} ${line.text.slice(0, 78)}`);
      }
    }
    
    this.outputBuffer.push("└" + "─".repeat(50));
  }
  
  private renderQuestions(data: QuestionData): void {
    this.outputBuffer.push("┌─ Questions " + "─".repeat(40));
    
    for (const q of data.questions) {
      this.outputBuffer.push(`│`);
      this.outputBuffer.push(`│ ${q.text}`);
      
      if (q.type === "choice" && q.choices) {
        for (let i = 0; i < q.choices.length; i++) {
          const marker = i === 0 ? "▸" : "○";
          this.outputBuffer.push(`│   ${marker} ${q.choices[i]}`);
        }
      } else if (q.type === "confirm") {
        this.outputBuffer.push(`│   [Y/n]`);
      } else {
        this.outputBuffer.push(`│   [${q.default || "..."}]`);
      }
    }
    
    this.outputBuffer.push("└" + "─".repeat(50));
  }
  
  private renderMilestone(data: MilestoneData): void {
    this.outputBuffer.push(`🎯 ${data.title}`);
    
    const done = data.items.filter(i => i.status === "done").length;
    const total = data.items.length;
    const percent = Math.round((done / total) * 100);
    
    // Progress bar
    const width = 30;
    const filled = Math.round((percent / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    this.outputBuffer.push(`${bar} ${percent}% (${done}/${total})`);
    this.outputBuffer.push("");
    
    // Items
    const icons = {
      pending: "○",
      running: "◐",
      done: "✓",
      error: "✗"
    };
    
    for (const item of data.items) {
      let line = `  ${icons[item.status]} ${item.label}`;
      if (item.details) line += ` - ${item.details}`;
      this.outputBuffer.push(line);
    }
  }
  
  private renderStatus(data: { message: string; type: "info" | "success" | "error" | "warning" }): void {
    const icons = {
      info: "ℹ",
      success: "✓",
      error: "✗",
      warning: "⚠"
    };
    
    this.outputBuffer.push(`${icons[data.type]} ${data.message}`);
  }
}

// TUI Builder - fluent API for building complex UIs
export class TUIBuilder {
  private components: TUIComponent[] = [];
  
  spinner(id: string, message: string, status: SpinnerData["status"] = "running"): this {
    this.components.push({ type: "spinner", id, data: { message, status } });
    return this;
  }
  
  success(id: string, message: string): this {
    this.components.push({ type: "spinner", id, data: { message, status: "success" } });
    return this;
  }
  
  error(id: string, message: string): this {
    this.components.push({ type: "spinner", id, data: { message, status: "error" } });
    return this;
  }
  
  progress(id: string, current: number, total: number, message?: string, eta?: string): this {
    this.components.push({ type: "progress", id, data: { current, total, message, eta } });
    return this;
  }
  
  table(id: string, headers: string[], rows: string[][], footer?: string): this {
    this.components.push({ type: "table", id, data: { headers, rows, footer } });
    return this;
  }
  
  tree(id: string, label: string, children?: TreeData[], status?: TreeData["status"]): this {
    this.components.push({ type: "tree", id, data: { label, children, status } });
    return this;
  }
  
  status(id: string, message: string, type: "info" | "success" | "error" | "warning" = "info"): this {
    this.components.push({ type: "status", id, data: { message, type } });
    return this;
  }
  
  divider(id: string): this {
    this.components.push({ type: "divider", id, data: null });
    return this;
  }
  
  filepicker(id: string, path: string, files: FilePickerData["files"]): this {
    this.components.push({ type: "filepicker", id, data: { path, files } });
    return this;
  }
  
  preview(id: string, title: string, content: string, language?: string): this {
    this.components.push({ type: "preview", id, data: { title, content, language, lineNumbers: true } });
    return this;
  }
  
  milestone(id: string, title: string, items: MilestoneData["items"]): this {
    this.components.push({ type: "milestone", id, data: { title, items } });
    return this;
  }
  
  build(): string {
    const renderer = new TUIRenderer();
    for (const component of this.components) {
      renderer.setComponent(component);
    }
    return renderer.render();
  }
}

// Legacy TUI export for backward compatibility
export const TUI = {
  spinner: (id: string, message: string) => ({ type: "spinner" as const, id, data: { message, status: "running" as const } }),
  success: (id: string, message: string) => ({ type: "spinner" as const, id, data: { message, status: "success" as const } }),
  error: (id: string, message: string) => ({ type: "spinner" as const, id, data: { message, status: "error" as const } }),
  progress: (id: string, current: number, total: number, message?: string) => ({ 
    type: "progress" as const, id, data: { current, total, message } 
  }),
  table: (id: string, headers: string[], rows: string[][]) => ({ type: "table" as const, id, data: { headers, rows } }),
  tree: (id: string, label: string, children?: TreeData[], status?: TreeData["status"]) => ({ 
    type: "tree" as const, id, data: { label, children, status } 
  }),
  status: (id: string, message: string, type: "info" | "success" | "error" | "warning" = "info") => ({ 
    type: "status" as const, id, data: { message, type } 
  }),
  divider: (id: string) => ({ type: "divider" as const, id, data: null }),
  builder: () => new TUIBuilder()
};

// Parse TUI commands from extension output
export function parseTUICommands(output: string): { text: string; components: TUIComponent[] } {
  const components: TUIComponent[] = [];
  
  const text = output.replace(/\[\[TUI:(\w+):([^:]+)(?::([^\]]*))?\]\]/g, (match, type, id, data) => {
    try {
      switch (type) {
        case "spinner":
          components.push(TUI.spinner(id, data || "Loading..."));
          break;
        case "success":
          components.push(TUI.success(id, data || "Done"));
          break;
        case "error":
          components.push(TUI.error(id, data || "Failed"));
          break;
        case "progress": {
          const parts = (data || "0/100").split("/");
          components.push(TUI.progress(id, parseInt(parts[0]), parseInt(parts[1]), parts[2]));
          break;
        }
        case "divider":
          components.push(TUI.divider(id));
          break;
      }
    } catch {
      // Ignore invalid TUI commands
    }
    return "";
  });
  
  return { text: text.trim(), components };
}

// Export createTUIResponse for backward compatibility
export function createTUIResponse(components: TUIComponent[]): string {
  const renderer = new TUIRenderer();
  for (const component of components) {
    renderer.setComponent(component);
  }
  return renderer.render();
}
