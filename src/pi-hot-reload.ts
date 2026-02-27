// Hot reloading for Pi-style extensions
// Watches .blob/extensions/ and reloads on change

import type { SqlStorage } from "./storage";
import { registerExtension, loadExtensions } from "./pi-tools";

// Track last reload time per extension
const lastReloadTimes = new Map<string, number>();
const RELOAD_DEBOUNCE_MS = 1000;

// Global flag to disable hot reload (for tests)
let globalHotReloadEnabled = true;

export function disableHotReload(): void {
  globalHotReloadEnabled = false;
}

export function enableHotReload(): void {
  globalHotReloadEnabled = true;
}

export interface FileWatcher {
  watch: (path: string, callback: () => void) => void;
  unwatch: (path: string) => void;
}

// Polling-based file watcher using sandbox for file stats
export class SandboxFileWatcher implements FileWatcher {
  private intervals = new Map<string, number>();
  private lastModified = new Map<string, number>();
  
  constructor(
    private sandbox: { exec: (cmd: string) => Promise<{ stdout?: string; exitCode?: number }> }
  ) {}
  
  watch(path: string, callback: () => void): void {
    // Initial stat
    this.getFileStats(path).then(stats => {
      this.lastModified.set(path, stats.mtime);
    }).catch(() => {
      this.lastModified.set(path, 0);
    });
    
    // Poll every 2 seconds
    const interval = setInterval(async () => {
      try {
        const stats = await this.getFileStats(path);
        const lastMod = this.lastModified.get(path) || 0;
        
        if (stats.mtime > lastMod) {
          this.lastModified.set(path, stats.mtime);
          callback();
        }
      } catch {
        // File might not exist yet
      }
    }, 2000);
    
    this.intervals.set(path, interval as unknown as number);
  }
  
  unwatch(path: string): void {
    const interval = this.intervals.get(path);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(path);
      this.lastModified.delete(path);
    }
  }
  
  private async getFileStats(path: string): Promise<{ mtime: number }> {
    // Use stat command to get actual file modification time
    const result = await this.sandbox.exec(`stat -c %Y "${path}" 2>/dev/null || echo 0`);
    const mtime = parseInt(result.stdout?.trim() || "0", 10);
    return { mtime };
  }
}

// Extension reloader
export class ExtensionReloader {
  private watcher: SandboxFileWatcher;
  private watchedPaths = new Set<string>();
  
  constructor(
    private db: SqlStorage,
    private sandbox: { exec: (cmd: string) => Promise<{ stdout?: string; exitCode?: number }> }
  ) {
    this.watcher = new SandboxFileWatcher(sandbox);
  }
  
  // Start watching an extension directory
  watchExtension(extensionPath: string): void {
    if (!globalHotReloadEnabled) {
      return;
    }
    
    if (this.watchedPaths.has(extensionPath)) {
      return;
    }
    
    const toolJsonPath = `${extensionPath}/tool.json`;
    
    this.watcher.watch(toolJsonPath, async () => {
      const now = Date.now();
      const lastReload = lastReloadTimes.get(extensionPath) || 0;
      
      if (now - lastReload < RELOAD_DEBOUNCE_MS) {
        return;
      }
      
      lastReloadTimes.set(extensionPath, now);
      
      try {
        await this.reloadExtension(extensionPath);
        console.log(`[HOT RELOAD] Reloaded extension: ${extensionPath}`);
      } catch (error) {
        console.error(`[HOT RELOAD] Failed to reload ${extensionPath}:`, error);
      }
    });
    
    this.watchedPaths.add(extensionPath);
  }
  
  // Reload a single extension
  async reloadExtension(extensionPath: string): Promise<void> {
    // Read tool.json
    const toolJsonResult = await this.sandbox.exec(`cat "${extensionPath}/tool.json"`);
    if (toolJsonResult.exitCode !== 0) {
      throw new Error("tool.json not found");
    }
    
    const toolDef = JSON.parse(toolJsonResult.stdout || "{}");
    
    // Find the script file
    const scriptResult = await this.sandbox.exec(`ls "${extensionPath}"/tool.* 2>/dev/null | head -1`);
    const scriptPath = scriptResult.stdout?.trim();
    
    if (!scriptPath) {
      throw new Error("No tool script found");
    }
    
    // Re-register the extension
    registerExtension(this.db, toolDef.name, toolDef.description || "", scriptPath, toolDef.input_schema || {});
  }
  
  // Watch all extensions
  async watchAllExtensions(): Promise<void> {
    if (!globalHotReloadEnabled) {
      return;
    }
    
    const result = await this.sandbox.exec("ls -d .blob/extensions/*/ 2>/dev/null");
    
    if (result.exitCode !== 0) {
      return;
    }
    
    const extensionDirs = (result.stdout || "").trim().split("\n").filter(Boolean);
    
    for (const dir of extensionDirs) {
      this.watchExtension(dir.replace(/\/$/, ""));
    }
  }
  
  stopWatching(extensionPath: string): void {
    this.watcher.unwatch(`${extensionPath}/tool.json`);
    this.watchedPaths.delete(extensionPath);
  }
  
  stopAll(): void {
    for (const path of this.watchedPaths) {
      this.watcher.unwatch(`${path}/tool.json`);
    }
    this.watchedPaths.clear();
  }
}

// Quick reload check for before tool execution
let hotReloadEnabled = true;

export function setHotReloadEnabled(enabled: boolean): void {
  hotReloadEnabled = enabled;
}

export async function checkExtensionReload(
  db: SqlStorage,
  sandbox: { exec: (cmd: string) => Promise<{ stdout?: string; exitCode?: number }> },
  extensionName: string
): Promise<boolean> {
  if (!hotReloadEnabled || !globalHotReloadEnabled) {
    return false;
  }
  
  const extensionPath = `.blob/extensions/${extensionName}`;
  
  // Check if tool.json exists
  const result = await sandbox.exec(`test -f "${extensionPath}/tool.json" && echo exists`);
  if (result.stdout?.trim() !== "exists") {
    return false;
  }
  
  // Get current hash from DB
  const dbResult = db.exec(
    "SELECT hash FROM extensions WHERE name = ?",
    extensionName
  );
  const currentHash = (dbResult.toArray()[0] as { hash?: string })?.hash;
  
  // Calculate new hash
  const contentResult = await sandbox.exec(`cat "${extensionPath}/tool.json" "${extensionPath}"/tool.* 2>/dev/null | sha256sum`);
  const newHash = contentResult.stdout?.trim();
  
  if (newHash && newHash !== currentHash) {
    // Reload needed
    const reloader = new ExtensionReloader(db, sandbox);
    await reloader.reloadExtension(extensionPath);
    return true;
  }
  
  return false;
}
