// Slack Block Kit components for rich messaging
// Replaces terminal TUI with Slack-native UI

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
  ephemeral?: boolean;
}

// Slack Block Kit Builder
export class SlackBlockBuilder {
  private blocks: SlackBlock[] = [];
  private text = "";

  textContent(content: string): this {
    this.text = content;
    return this;
  }

  section(text: string, accessory?: SlackBlock): this {
    const block: SlackBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    };
    if (accessory) block.accessory = accessory;
    this.blocks.push(block);
    return this;
  }

  divider(): this {
    this.blocks.push({ type: "divider" });
    return this;
  }

  context(elements: Array<{ type: "mrkdwn" | "image"; text?: string; image_url?: string; alt_text?: string }>): this {
    this.blocks.push({
      type: "context",
      elements
    });
    return this;
  }

  header(text: string): this {
    this.blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text,
        emoji: true
      }
    });
    return this;
  }

  actions(buttons: Array<{ text: string; action_id: string; value?: string; style?: "primary" | "danger" }>): this {
    this.blocks.push({
      type: "actions",
      elements: buttons.map(b => ({
        type: "button",
        text: {
          type: "plain_text",
          text: b.text,
          emoji: true
        },
        action_id: b.action_id,
        value: b.value || b.action_id,
        style: b.style
      }))
    });
    return this;
  }

  // Progress indicator using context
  progress(label: string, current: number, total: number): this {
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((percent / 100) * 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    
    this.context([{
      type: "mrkdwn",
      text: `${label}: ${bar} ${percent}% (${current}/${total})`
    }]);
    return this;
  }

  // Status with emoji
  status(message: string, type: "info" | "success" | "error" | "warning" = "info"): this {
    const emojis = {
      info: "ℹ️",
      success: "✅",
      error: "❌",
      warning: "⚠️"
    };
    this.section(`${emojis[type]} ${message}`);
    return this;
  }

  // Code block
  code(content: string, language?: string): this {
    this.blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${language || ""}\n${content.slice(0, 2900)}\n\`\`\``
      }
    });
    return this;
  }

  build(): SlackMessage {
    return {
      text: this.text,
      blocks: this.blocks.length > 0 ? this.blocks : undefined
    };
  }
}

// Quick builders
export const SlackUI = {
  builder: () => new SlackBlockBuilder(),
  
  // Simple status message
  status: (message: string, type: "info" | "success" | "error" | "warning" = "info") => {
    const emojis = { info: "ℹ️", success: "✅", error: "❌", warning: "⚠️" };
    return new SlackBlockBuilder().section(`${emojis[type]} ${message}`).build();
  },

  // Progress update
  progress: (label: string, current: number, total: number) => {
    return new SlackBlockBuilder().progress(label, current, total).build();
  },

  // Approval request with buttons
  approval: (message: string, actionId: string) => {
    return new SlackBlockBuilder()
      .section(message)
      .actions([
        { text: "✓ Approve", action_id: `${actionId}_approve`, style: "primary" },
        { text: "✗ Reject", action_id: `${actionId}_reject", style: "danger" }
      ])
      .build();
  },

  // Code snippet
  code: (content: string, language?: string) => {
    return new SlackBlockBuilder().code(content, language).build();
  }
};

// Parse TUI commands and convert to Slack blocks
export function parseTUIToSlack(output: string): SlackMessage {
  const builder = new SlackBlockBuilder();
  
  // Extract TUI commands
  const tuiPattern = /\[\[TUI:(\w+):([^:]+)(?::([^\]]*))?\]\]/g;
  let match;
  
  while ((match = tuiPattern.exec(output)) !== null) {
    const [, type, id, data] = match;
    
    switch (type) {
      case "spinner":
        builder.status(data || "Loading...", "info");
        break;
      case "success":
        builder.status(data || "Done", "success");
        break;
      case "error":
        builder.status(data || "Failed", "error");
        break;
      case "progress": {
        const [current, total, label] = (data || "0/100").split("/");
        builder.progress(label || "Progress", parseInt(current), parseInt(total));
        break;
      }
      case "divider":
        builder.divider();
        break;
    }
  }
  
  // Clean text (remove TUI commands)
  const cleanText = output.replace(tuiPattern, "").trim();
  if (cleanText) {
    builder.textContent(cleanText);
  }
  
  return builder.build();
}
