import type { Env } from "./types";

export function withDOAuth(env: Pick<Env, "DO_AUTH_SECRET"> | undefined, init?: RequestInit): RequestInit | undefined {
  if (!env?.DO_AUTH_SECRET) {
    return init;
  }

  const currentHeaders = init?.headers && !(init.headers instanceof Headers) ? init.headers : {};
  if (env?.DO_AUTH_SECRET) {
    return { ...init, headers: { ...currentHeaders, "x-do-auth": env.DO_AUTH_SECRET } };
  }
  return init;
}
