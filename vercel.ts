import { type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Migrations run before the build so a bad migration fails the deployment
  // instead of shipping an app against a stale schema. drizzle.config.ts calls
  // dotenv on .env.local, which doesn't exist in a Vercel build; dotenv treats
  // a missing file as a no-op, so the injected Vercel environment is used.
  buildCommand: "npm run db:migrate && next build",
  // Hobby permits one cron invocation per day at an imprecise time. The
  // scheduler tick, delivery retries, and the unresolved-event sweep therefore
  // all run daily. Restore "0 * * * *" on upgrading to Pro.
  crons: [{ path: "/api/cron/scheduler", schedule: "0 9 * * *" }],
};
