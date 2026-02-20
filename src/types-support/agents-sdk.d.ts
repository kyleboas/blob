declare module "@cloudflare/agents" {
  export class Agent {
    constructor(state: unknown, env: unknown);
    /** Agent state managed by the SDK. Read-only — use setState() to update. */
    readonly state: unknown;
    setState(state: unknown): Promise<void>;
  }
}
