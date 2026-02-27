// TUI (Terminal UI) Extensions for Pi-style Blob
// Rich terminal components: spinners, progress bars, tables, etc.

export interface TUIComponent {
  type: "spinner" | "progress" | "table" | "tree" | "status" | "divider";
  id: string;
  data: unknown;
}

export interface SpinnerData {
  message: string;
  status?: "running" | "success" | "error";
}

export interface ProgressData {
  current: number;
  total: number;
  message?: string;
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface TreeData {
  label: string;
  children?: TreeData[];
  status?: "pending" | "done" | "error";
}

// TUI Renderer - converts components to terminal output
export class TUIRenderer {
  private components = new Map<string, TUIComponent>();
  private outputBuffer: string[] = [];
  
  // Add or update a component
  setComponent(component: TUIComponent): void {
    this.components.set(component.id, component);
  }
  
  // Remove a component
  removeComponent(id: string): void {
    this.components.delete(id);
  }
  
  // Render all components to string
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
        this.renderSpinner(component.data as SpinnerData, component.id);
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
    }
  }
  
  private renderSpinner(data: SpinnerData, id: string): void {
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spinner = data.status === "running" 
      ? spinners[Date.now() / 100 % spinners.length | 0]
      : data.status === "success" ? "✓" : data.status === "error" ? "✗" : "○";
    
    this.outputBuffer.push(`${spinner} ${data.message}`);
  }
  
  private renderProgress(data: ProgressData): void {
    const width = 30;
    const filled = Math.round((data.current / data.total) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const percent = Math.round((data.current / data.total) * 100);
    
    this.outputBuffer.push(
      `${bar} ${percent}% (${data.current}/${data.total})${data.message ? " " + data.message : ""}`
    );
  }
  
  private renderTable(data: TableData): void {
    // Calculate column widths
    const widths = data.headers.map((h, i) => {
      const maxDataWidth = Math.max(...data.rows.map(r => (r[i] || "").length));
      return Math.max(h.length, maxDataWidth, 10);
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
  }
  
  private renderTree(data: TreeData, depth: number): void {
    const indent = "  ".repeat(depth);
    const icon = data.status === "done" ? "✓" : data.status === "error" ? "✗" : "○";
    
    this.outputBuffer.push(`${indent}${icon} ${data.label}`);
    
    if (data.children) {
      for (const child of data.children) {
        this.renderTree(child, depth + 1);
      }
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

// TUI Extension helper - extensions can use this to render rich output
export function createTUIResponse(components: TUIComponent[]): string {
  const renderer = new TUIRenderer();
  
  for (const component of components) {
    renderer.setComponent(component);
  }
  
  return renderer.render();
}

// Pre-built TUI components for common patterns
export const TUI = {
  // Running task spinner
  spinner(id: string, message: string): TUIComponent {
    return { type: "spinner", id, data: { message, status: "running" } };
  },
  
  // Success spinner
  success(id: string, message: string): TUIComponent {
    return { type: "spinner", id, data: { message, status: "success" } };
  },
  
  // Error spinner
  error(id: string, message: string): TUIComponent {
    return { type: "spinner", id, data: { message, status: "error" } };
  },
  
  // Progress bar
  progress(id: string, current: number, total: number, message?: string): TUIComponent {
    return { type: "progress", id, data: { current, total, message } };
  },
  
  // Data table
  table(id: string, headers: string[], rows: string[][]): TUIComponent {
    return { type: "table", id, data: { headers, rows } };
  },
  
  // Tree view
  tree(id: string, label: string, children?: TreeData[], status?: TreeData["status"]): TUIComponent {
    return { type: "tree", id, data: { label, children, status } };
  },
  
  // Status message
  status(id: string, message: string, type: "info" | "success" | "error" | "warning" = "info"): TUIComponent {
    return { type: "status", id, data: { message, type } };
  },
  
  // Divider line
  divider(id: string): TUIComponent {
    return { type: "divider", id, data: null };
  }
};

// Parse TUI commands from extension output
// Extensions can output: [[TUI:spinner:id:message]]
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
        case "progress":
          const [current, total, message] = (data || "0/100").split("/");
          components.push(TUI.progress(id, parseInt(current), parseInt(total), message));
          break;
        case "divider":
          components.push(TUI.divider(id));
          break;
      }
    } catch {
      // Ignore invalid TUI commands
    }
    return ""; // Remove TUI command from text
  });
  
  return { text: text.trim(), components };
}
