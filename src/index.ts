import { Elysia } from "elysia";
import { getConfig } from "./config";
import { openDb } from "./lib/db";
import { clearAllJobs } from "./services/store";
import { Semaphore } from "./pipeline/queue";
import { handleUpdate, verifySecret } from "./handlers/telegram-webhook";

const cfg = getConfig();
const db = openDb(cfg.databasePath);
clearAllJobs(db); // no jobs survive a restart — drop any stale locks
const sem = new Semaphore(cfg.maxConcurrentJobs);

const app = new Elysia()
  .get("/", () => "MyanCap up")
  .post("/telegram/webhook", ({ body, headers, set }) => {
    if (!verifySecret(headers["x-telegram-bot-api-secret-token"])) {
      set.status = 401;
      return { ok: false };
    }
    // Fire-and-forget: ack immediately, process in the background.
    void handleUpdate(db, sem, body as any);
    return { ok: true };
  })
  .listen(cfg.port);

console.log(`🦊 MyanCap on :${app.server?.port}`);
