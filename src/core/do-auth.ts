import type { Env } from "./types";

export function withDOAuth(env: Pick<Env, "DO_AUTH_SECRET"> | undefined, init?: RequestInit): RequestInit | undefined {
  if (!env?.DO_AUTH_SECRET) {
    return init;
  }

  // Normalize existing headers to a plain object so we can spread them
  let currentHeaders: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => { currentHeaders[key] = value; });
    } else {
      currentHeaders = init.headers as Record<string, string>;
    }
  }

  return { ...init, headers: { ...currentHeaders, "x-do-auth": env.DO_AUTH_SECRET } };
}
