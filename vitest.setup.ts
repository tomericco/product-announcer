import { config } from "dotenv";

// Pin the test run to a non-UTC zone, set before anything below constructs a
// `Date`. `tests/lib/content/calendar.test.ts`'s local-day tests only prove
// anything when local time differs from UTC — a `getUTCDate()`
// implementation would pass them just as well as the real `getDate()` one on
// a UTC machine, which is exactly the bug this pin exists to catch.
// Asia/Jerusalem observes DST (UTC+2 in winter, UTC+3 roughly late March -
// late October); the calendar test's boundary cases use August/September
// dates, which fall inside that UTC+3 window — see the comment there for why
// the offset matters.
process.env.TZ = "Asia/Jerusalem";

config({ path: ".env.local" });

// Tests run against real Postgres, and several of them call un-scoped, all-tenant
// functions (e.g. runSchedulerTick) that would mutate EVERY workspace in the
// database — including real dev data — if pointed at the dev database. So the
// suite must run against a dedicated test database, and we hard-fail rather than
// ever touch a database whose name doesn't end in "_test".
function deriveTestUrl(devUrl: string): string {
  const url = new URL(devUrl);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
  return url.toString();
}

const explicit = process.env.TEST_DATABASE_URL;
const devUrl = process.env.DATABASE_URL;
const testUrl = explicit ?? (devUrl ? deriveTestUrl(devUrl) : undefined);

if (!testUrl) {
  throw new Error(
    "Tests need a database: set DATABASE_URL (a _test database is derived from it) or TEST_DATABASE_URL in .env.local."
  );
}

const dbName = new URL(testUrl).pathname.replace(/^\//, "");
if (!dbName.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests against database "${dbName}" — the test database name must end in "_test". ` +
      "Point TEST_DATABASE_URL at a dedicated test database (see .env.local)."
  );
}

process.env.DATABASE_URL = testUrl;
