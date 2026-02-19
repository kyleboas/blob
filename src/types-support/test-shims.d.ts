declare module "vitest" {
  export const describe: any;
  export const it: any;
  export const expect: any;
  export const vi: any;
}

declare module "@cloudflare/vitest-pool-workers/config" {
  export function defineWorkersConfig(config: unknown): unknown;
}
