// Hot reloading for Pi-style extensions
// Watches .blob/extensions/ and reloads on change

import type { SqlStorage } from "./storage";
import { registerExtension, loadExtensions } from "./pi-tools";

// Track last reload time per extension
const lastReloadTimes = new Map<string, number>();
const RELOAD_DEBOUNCE_MS = 1000; // Don't reload same extension more than once per second

export interface FileWatcher {
  watch: (path: string, callback: () => void) => void;
  unwatch: (path: string) => void;
}

// Simple polling-based file watcher (works in sandboxed environments)
export class PollingFileWatcher implements FileWatcher {
  private intervals = new Map<string, number>();
  private lastModified = new Map<string, number>();
  
  watch(path: string, callback: () => void): void {
    // Poll every 2 seconds for file changes
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
    // This would need to be passed in or use a different approach
    // For now, return current time to trigger reload
    return { mtime: Date.now() };
  }
}

// Extension reloader
export class ExtensionReloader {
  private watcher: PollingFileWatcher;
  private watchedPaths = new Set<string>();
  
  constructor(
    private db: SqlStorage,
    private sandbox: { exec: (cmd: string) => Promise<{ stdout?: string; exitCode?: number }> }
  ) {
    this.watcher = new PollingFileWatcher();
  }
  
  // Start watching an extension directory
  watchExtension(extensionPath: string): void {
    if (this.watchedPaths.has(extensionPath)) {
      return; // Already watching
    }
    
    const toolJsonPath = `${extensionPath}/tool.json`;
    
    this.watcher.watch(toolJsonPath, async () => {
      const now = Date.now();
      const lastReload = lastReloadTimes.get(extensionPath) || 0;
      
      if (now - lastReload < RELOAD_DEBOUNCE_MS) {
        return; // Debounce
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
  private async reloadExtension(extensionPath: string): Promise<void> {
    // Read tool.json
    const toolJsonResult = await this.sandbox.exec(`cat "${extensionPath}/tool.json"`);
    if (toolJsonResult.exitCode !== 0) {
      throw new Error("tool.json not found");
    }
    
    const toolDef = JSON.parse(toolJsonResult.stdout || "{}");
    
    // Find the script file (tool.sh, tool.ts, etc.)
    const scriptResult = await this.sandbox.exec(`ls "${extensionPath}"/tool.* 2>/dev/null | head -1`);
    const scriptPath = scriptResult.stdout?.trim();
    
    if (!scriptPath) {
      throw new Error("No tool script found");
    }
    
    // Re-register the extension
    registerExtension(
      this.db,
      toolDef.name,
      toolDef.description,
      scriptPath,
      toolDef.input_schema
    );
  }
  
  // Watch all extensions in .blob/extensions/
  async watchAllExtensions(): Promise<void> {
    const result = await this.sandbox.exec("ls -d .blob/extensions/*/ 2>/dev/null");
    
    if (result.exitCode !== 0) {
      return; // No extensions directory
    }
    
    const extensionDirs = (result.stdout || "").trim().split("\n").filter(Boolean);
    
    for (const dir of extensionDirs) {
      this.watchExtension(dir.replace(/\/$/, ""));
    }
  }
  
  // Stop watching
  stopWatching(extensionPath: string): void {
    this.watcher.unwatch(`${extensionPath}/tool.json`);
    this.watchedPaths.delete(extensionPath);
  }
  
  // Stop all watchers
  stopAll(): void {
    for (const path of this.watchedPaths) {
      this.watcher.unwatch(`${path}/tool.json`);
    }
    this.watchedPaths.clear();
  }
}

// Quick reload check - call this before using an extension
// Set to false to disable (useful for tests)
let hotReloadEnabled = true;

export function setHotReloadEnabled(enabled: boolean): void {
  hotReloadEnabled = enabled;
}

export async function checkExtensionReload(
  db: SqlStorage,
  sandbox: { exec: (cmd: string) => Promise<{ stdout?: string; exitCode?: number }> },
  extensionName: string
): Promise<boolean> {
  if (!hotReloadEnabled) {
    return false;
  }
  
  const extensions = loadExtensions(db);
  const extension = extensions.find(e => e.name === extensionName);
  
  if (!extension) {
    return false;
  }
  
  // Check if tool.json has been modified since last reload
  const toolJsonPath = extension.scriptPath.replace(/\/tool\.[^/]+$/, "/tool.json");
  
  try {
    const result = await sandbox.exec(`stat -c %Y "${toolJsonPath}" 2>/dev/null || echo "0"`);
    const mtime = parseInt(result.stdout || "0", 10) * 1000;
    
    const lastReload = lastReloadTimes.get(extensionName) || 0;
    
    if (mtime > lastReload) {
      // Extension has changed, reload it
      const toolJsonResult = await sandbox.exec(`cat "${toolJsonPath}"`);
      const toolDef = JSON.parse(toolJsonResult.stdout || "{}");
      
      registerExtension(
        db,
        toolDef.name,
        toolDef.description,
        extension.scriptPath,
        toolDef.input_schema
      );
      
      lastReloadTimes.set(extensionName, Date.now());
      return true;
    }
  } catch {
    // Ignore errors
  }
  
  return false;
}
