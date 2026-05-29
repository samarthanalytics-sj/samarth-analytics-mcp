import type { IncomingMessage, ServerResponse } from "node:http";
import { clearSessionCookie, sendJson } from "../../server/gtm/vercel-helpers";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  clearSessionCookie(res);
  sendJson(res, 200, { connected: false });
}
