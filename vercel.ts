import { type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Declared explicitly because this project was created with `vercel project
  // add` rather than a git import, so Vercel never auto-detected a framework,
  // and the custom buildCommand below suppresses inference. Without this the
  // build succeeds but packaging fails with "No Output Directory named
  // 'public' found" — Vercel treats the result as a static site instead of
  // reading .next.
  framework: "nextjs",
  // Migrations run before the build so a bad migration fails the deployment
  // instead of shipping an app against a stale schema. drizzle.config.ts calls
  // dotenv on .env.local, which doesn't exist in a Vercel build; dotenv treats
  // a missing file as a no-op, so the injected Vercel environment is used.
  buildCommand: "npm run db:migrate && next build",
  // `npm ci`, not the default `npm install`. Vercel restores node_modules from
  // a build cache, and `npm install` then reconciles it incrementally — which
  // it can get wrong. It shipped a production build carrying a stale
  // sharp@0.34.5 while the lockfile said 0.35.3, reported "up to date in 2s",
  // and left sharp's libvips native library missing, so every route that
  // transitively imported image code died on load with ERR_DLOPEN_FAILED.
  // `npm ci` deletes node_modules and installs exactly what the lockfile says,
  // which is the property a deploy needs — a cache may make a build faster,
  // never different.
  installCommand: "npm ci",
  // Hobby permits one cron invocation per day at an imprecise time. Delivery
  // retries and the unresolved-event sweep therefore run daily. Restore
  // "0 * * * *" on upgrading to Pro.
  crons: [{ path: "/api/cron/scheduler", schedule: "0 9 * * *" }],
};
