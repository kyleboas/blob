import type { Env } from "./types";

export default {
  fetch(_request: Request, _env: Env): Response {
    return new Response("ok");
  }
};
