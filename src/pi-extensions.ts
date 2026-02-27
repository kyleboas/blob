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

  // Model picker extension - agent selects LLM model
  try {
    registerExtension(
      sql,
      "model",
      "Select LLM model for task. Auto-picks based on task complexity or manual override",
      ".blob/extensions/model/model.sh",
      {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["list", "pick", "switch", "auto", "info"]
          },
          task: { type: "string" },
          model: { type: "string", enum: ["chat", "routine", "complex"] }
        },
        required: ["command"]
      }
    );
    console.log("[EXTENSIONS] Registered model picker extension");
  } catch (error) {
    console.log("[EXTENSIONS] Model picker extension already registered");
  }
}
