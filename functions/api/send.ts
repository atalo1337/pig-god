interface Env {
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURE?: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM: string;
}

type SendPayload = {
  to: string;
  subject: string;
  text: string;
  count?: number;
  intervalMs?: number;
};

const MAX_COUNT = 200;
const MIN_INTERVAL_MS = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function asBool(value: string | undefined, defaultVal: boolean): boolean {
  if (value === undefined) return defaultVal;
  return String(value).toLowerCase() === "true";
}

function asInt(value: unknown, defaultVal: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : defaultVal;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = (await request.json()) as SendPayload;
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const text = String(body.text || "");
    const count = Math.min(Math.max(asInt(body.count, 1), 1), MAX_COUNT);
    const intervalMs = Math.max(asInt(body.intervalMs, 500), MIN_INTERVAL_MS);

    if (!to || !subject || !text) {
      return json(
        { error: "字段缺失：to / subject / text 均为必填" },
        { status: 400 }
      );
    }

    const secure = asBool(env.SMTP_SECURE, true);
    const port = Number(env.SMTP_PORT || (secure ? 465 : 587));

    const { SMTPClient } = await import("emailjs");

    const client = new SMTPClient({
      host: env.SMTP_HOST,
      port,
      ssl: secure,
      user: env.SMTP_USER,
      password: env.SMTP_PASS,
    });

    const details: Array<{ index: number; ok: boolean; error?: string }> = [];

    for (let i = 1; i <= count; i++) {
      try {
        await client.sendAsync({
          from: env.SMTP_FROM,
          to,
          subject,
          text,
        });
        details.push({ index: i, ok: true });
      } catch (error) {
        details.push({
          index: i,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (i < count && intervalMs > 0) {
        await sleep(intervalMs);
      }
    }

    const ok = details.filter((d) => d.ok).length;
    const failed = details.length - ok;

    return json({ ok, failed, count, intervalMs, details });
  } catch (error) {
    return json(
      {
        error: "请求处理失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}
