import { Elysia, t } from "elysia";
import { synthesizeSpeech } from "./services/tts";
import { srtToSpeech } from "./services/srt-tts";
import { handleUpdate, verifySecret } from "./handlers/telegram-webhook";

const app = new Elysia()
  .get("/", () => "Hello Elysia")
  .post(
    "/tts",
    async ({ body }) => {
      const audio = await synthesizeSpeech(body.text, { voice: body.voice });
      return new Response(audio, {
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
    {
      body: t.Object({
        text: t.String(),
        voice: t.Optional(t.String()),
      }),
    }
  )
  .post(
    "/tts/srt",
    async ({ body }) => {
      const wav = await srtToSpeech(body.srt, { voice: body.voice });
      return new Response(wav.buffer as ArrayBuffer, {
        headers: { "Content-Type": "audio/wav" },
      });
    },
    {
      body: t.Object({
        srt: t.String(),
        voice: t.Optional(t.String()),
      }),
    }
  )
  .post("/telegram/webhook", ({ body, headers, set }) => {
    if (!verifySecret(headers["x-telegram-bot-api-secret-token"])) {
      set.status = 401;
      return { ok: false };
    }
    handleUpdate(body as any);
    return { ok: true };
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
