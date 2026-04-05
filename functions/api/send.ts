import { connect } from "cloudflare:sockets";

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

function encodeB64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function formatMessage(from: string, to: string, subject: string, text: string): string {
  const safeText = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    safeText,
    "",
  ].join("\r\n");
}

async function sendSmtpMail(params: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}) {
  const { host, port, secure, user, pass, from, to, subject, text } = params;
  const transport: "on" | "off" | "starttls" = secure ? "on" : "starttls";
  let socket = connect({ hostname: host, port }, { secureTransport: transport });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  const readLine = async (): Promise<string> => {
    while (true) {
      const idx = pending.indexOf("\n");
      if (idx >= 0) {
        const line = pending.slice(0, idx + 1);
        pending = pending.slice(idx + 1);
        return line.replace(/\r?\n$/, "");
      }
      const { value, done } = await reader.read();
      if (done) {
        if (!pending) throw new Error("SMTP 连接已关闭");
        const line = pending;
        pending = "";
        return line;
      }
      pending += decoder.decode(value, { stream: true });
    }
  };

  const readResponse = async () => {
    const lines: string[] = [];
    while (true) {
      const line = await readLine();
      lines.push(line);
      if (/^\d{3}\s/.test(line)) break;
      if (!/^\d{3}-/.test(line)) break;
    }
    const first = lines[0] || "";
    const code = Number(first.slice(0, 3));
    return { code, lines };
  };

  const expectCode = (code: number, expected: number[], lines: string[]) => {
    if (!expected.includes(code)) {
      throw new Error(`SMTP 响应异常: ${lines.join(" | ")}`);
    }
  };

  const sendCmd = async (cmd: string, expected: number[]) => {
    await writer.write(encoder.encode(`${cmd}\r\n`));
    const resp = await readResponse();
    expectCode(resp.code, expected, resp.lines);
    return resp;
  };

  try {
    const greet = await readResponse();
    expectCode(greet.code, [220], greet.lines);

    const ehlo = await sendCmd("EHLO localhost", [250]);
    const caps = ehlo.lines.map((l) => l.toUpperCase());

    if (!secure && caps.some((l) => l.includes("STARTTLS"))) {
      await sendCmd("STARTTLS", [220]);

      const upgraded = socket.startTls();
      await reader.cancel();
      writer.releaseLock();

      socket = upgraded;
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      pending = "";

      await sendCmd("EHLO localhost", [250]);
    }

    await sendCmd("AUTH LOGIN", [334]);
    await sendCmd(encodeB64(user), [334]);
    await sendCmd(encodeB64(pass), [235]);

    await sendCmd(`MAIL FROM:<${from}>`, [250]);
    await sendCmd(`RCPT TO:<${to}>`, [250, 251]);
    await sendCmd("DATA", [354]);

    const message = formatMessage(from, to, subject, text);
    await writer.write(encoder.encode(`${message}\r\n.\r\n`));
    const dataResp = await readResponse();
    expectCode(dataResp.code, [250], dataResp.lines);

    await sendCmd("QUIT", [221]);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await socket.close();
    } catch {
      // ignore
    }
  }
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

    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.SMTP_FROM) {
      return json({ error: "SMTP 配置不完整，请检查环境变量/Secrets" }, { status: 500 });
    }

    const secure = asBool(env.SMTP_SECURE, true);
    const port = Number(env.SMTP_PORT || (secure ? 465 : 587));

    if (port === 25) {
      return json(
        { error: "Cloudflare Workers 禁止连接 SMTP 25 端口，请改用 465 或 587" },
        { status: 400 }
      );
    }

    const details: Array<{ index: number; ok: boolean; error?: string }> = [];

    for (let i = 1; i <= count; i++) {
      try {
        await sendSmtpMail({
          host: env.SMTP_HOST,
          port,
          secure,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
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
