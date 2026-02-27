import type { SqlStorage } from "./storage";
import { registerExtension } from "./pi-tools";

// Auto-register built-in lightweight extensions
export function registerBuiltinExtensions(sql: SqlStorage): void {
  // Memory extension - simple key-value storage
  try {
    registerExtension(
      sql,
      "memory",
      "Simple key-value memory for saving lessons and recalling solutions",
      ".blob/extensions/memory/memory.sh",
      {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["save", "recall", "search", "list"]
          },
          key: { type: "string" },
          value: { type: "string" },
          query: { type: "string" }
        },
        required: ["command"]
      }
    );
    console.log("[EXTENSIONS] Registered memory extension");
  } catch (error) {
    // Extension might already exist
    console.log("[EXTENSIONS] Memory extension already registered");
  }
}
