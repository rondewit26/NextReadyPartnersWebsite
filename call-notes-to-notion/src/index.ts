import { handleIngest, isAuthorized, json } from "./ingest";
import { processPendingJobs } from "./process";
import type { Env, Job } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "call-notes-to-notion" });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    // Status van een job opvragen (handig bij debuggen vanaf de telefoon).
    const jobMatch = url.pathname.match(/^\/jobs\/([0-9a-f-]{8,})$/i);
    if (request.method === "GET" && jobMatch) {
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Niet geautoriseerd" }, 401);
      const raw = await env.JOBS.get(`job:${jobMatch[1]}`);
      if (!raw) return json({ ok: false, error: "Onbekende job (of al opgeruimd)" }, 404);
      const job = JSON.parse(raw) as Job;
      return json({ ok: true, status: job.status, attempts: job.attempts, error: job.error, url: job.pageUrl });
    }

    // Handmatig de verwerking aftrappen (lokaal testen zonder op de cron te wachten).
    if (request.method === "POST" && url.pathname === "/process") {
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Niet geautoriseerd" }, 401);
      const result = await processPendingJobs(env);
      return json({ ok: true, ...result });
    }

    return json({ ok: false, error: "Niet gevonden" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processPendingJobs(env));
  },
} satisfies ExportedHandler<Env>;
