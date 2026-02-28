// User preferences system for Blob
// Stores preferences in KV for persistence across sessions

export interface UserPreferences {
  // Response style
  responseStyle?: "concise" | "detailed" | "technical";
  includeEmojis?: boolean;
  includeCodeBlocks?: boolean;
  
  // Behavior
  autoApprove?: boolean;
  confirmDestructive?: boolean;
  maxStepsPerTask?: number;
  
  // Notifications
  notifyOnComplete?: boolean;
  notifyOnError?: boolean;
  
  // Custom preferences (extension-defined)
  [key: string]: unknown;
}

// Preferences manager using KV storage
export class PreferencesManager {
  private kvKey = "user-preferences";
  
  constructor(private kv?: KVNamespace) {}
  
  // Get all preferences
  async getAll(): Promise<UserPreferences> {
    if (!this.kv) return {};
    
    try {
      const prefs = await this.kv.get(this.kvKey);
      return prefs ? JSON.parse(prefs) : {};
    } catch {
      return {};
    }
  }
  
  // Get a specific preference
  async get<K extends keyof UserPreferences>(
    key: K
  ): Promise<UserPreferences[K] | undefined> {
    const prefs = await this.getAll();
    return prefs[key];
  }
  
  // Set a preference
  async set<K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ): Promise<boolean> {
    if (!this.kv) return false;
    
    try {
      const prefs = await this.getAll();
      prefs[key] = value;
      await this.kv.put(this.kvKey, JSON.stringify(prefs));
      return true;
    } catch {
      return false;
    }
  }
  
  // Set multiple preferences at once
  async setMultiple(prefs: Partial<UserPreferences>): Promise<boolean> {
    if (!this.kv) return false;
    
    try {
      const existing = await this.getAll();
      const updated = { ...existing, ...prefs };
      await this.kv.put(this.kvKey, JSON.stringify(updated));
      return true;
    } catch {
      return false;
    }
  }
  
  // Delete a preference
  async delete(key: keyof UserPreferences): Promise<boolean> {
    if (!this.kv) return false;
    
    try {
      const prefs = await this.getAll();
      delete prefs[key];
      await this.kv.put(this.kvKey, JSON.stringify(prefs));
      return true;
    } catch {
      return false;
    }
  }
  
  // Reset all preferences
  async reset(): Promise<boolean> {
    if (!this.kv) return false;
    
    try {
      await this.kv.put(this.kvKey, JSON.stringify({}));
      return true;
    } catch {
      return false;
    }
  }
  
  // Get preferences as formatted string for system prompt
  async getPromptContext(): Promise<string> {
    const prefs = await this.getAll();
    
    if (Object.keys(prefs).length === 0) {
      return "No user preferences configured.";
    }
    
    const lines = ["User Preferences:"];
    
    if (prefs.responseStyle) {
      lines.push(`- Response style: ${prefs.responseStyle}`);
    }
    if (prefs.includeEmojis !== undefined) {
      lines.push(`- Use emojis: ${prefs.includeEmojis ? 'yes' : 'no'}`);
    }
    if (prefs.autoApprove !== undefined) {
      lines.push(`- Auto-approve safe actions: ${prefs.autoApprove ? 'yes' : 'no'}`);
    }
    if (prefs.maxStepsPerTask) {
      lines.push(`- Max steps per task: ${prefs.maxStepsPerTask}`);
    }
    
    // Add custom preferences
    for (const [key, value] of Object.entries(prefs)) {
      if (!['responseStyle', 'includeEmojis', 'includeCodeBlocks', 
             'autoApprove', 'confirmDestructive', 'maxStepsPerTask',
             'notifyOnComplete', 'notifyOnError'].includes(key)) {
        lines.push(`- ${key}: ${value}`);
      }
    }
    
    return lines.join('\n');
  }
}

// Parse natural language preference commands
export function parsePreferenceCommand(text: string): 
  | { action: 'set'; key: string; value: string }
  | { action: 'get'; key?: string }
  | { action: 'delete'; key: string }
  | { action: 'reset' }
  | null {
  
  const lower = text.toLowerCase().trim();
  
  // Set preference
  // "set my preference for X to Y" or "I prefer X to be Y"
  const setPatterns = [
    /(?:set|change|update)\s+(?:my\s+)?(?:preference\s+)?(?:for\s+)?(.+?)\s+(?:to|as|is)\s+(.+)/i,
    /i\s+(?:prefer|want|like)\s+(.+?)\s+(?:to\s+be\s+)?(.+)/i,
    /make\s+(.+?)\s+(.+)/i
  ];
  
  for (const pattern of setPatterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        action: 'set',
        key: match[1].trim(),
        value: match[2].trim()
      };
    }
  }
  
  // Get preference
  // "what are my preferences" or "show preferences"
  if (/what\s+(?:are\s+)?my\s+(?:preferences|settings)/i.test(text) ||
      /show\s+(?:my\s+)?(?:preferences|settings)/i.test(text)) {
    return { action: 'get' };
  }
  
  // Get specific preference
  // "what is my X preference"
  const getMatch = text.match(/what\s+(?:is\s+)?my\s+(.+?)\s+(?:preference|setting)/i);
  if (getMatch) {
    return { action: 'get', key: getMatch[1].trim() };
  }
  
  // Delete preference
  // "delete my X preference" or "remove preference for X"
  const deleteMatch = text.match(/(?:delete|remove|clear)\s+(?:my\s+)?(?:preference\s+)?(?:for\s+)?(.+)/i);
  if (deleteMatch) {
    return {
      action: 'delete',
      key: deleteMatch[1].trim()
    };
  }
  
  // Reset preferences
  // "reset my preferences" or "clear all preferences"
  if (/reset\s+(?:my\s+)?(?:all\s+)?(?:preferences|settings)/i.test(text) ||
      /clear\s+(?:all\s+)?(?:preferences|settings)/i.test(text)) {
    return { action: 'reset' };
  }
  
  return null;
}
