import { appendEvent } from "./events.ts";
import type { JobRecord } from "./job.ts";

export type NotifyEvent = "job.completed" | "job.failed" | "job.cancelled" | "approval.requested" | "job.status";
export type NotifyResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export async function sendJobNotification(
  dir: string,
  job: JobRecord,
  event: NotifyEvent,
  approvalId?: string,
): Promise<NotifyResult> {
  const url = process.env.CODEXCTL_GROK_BOT_NOTIFY_URL;
  if (!url) {
    if (event !== "job.status") {
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "notify.skipped", reason: "not_configured" },
        at: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return { ok: false, error: { code: "notify_not_configured", message: "CODEXCTL_GROK_BOT_NOTIFY_URL is not configured" } };
  }
  const key = process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY;
  // Never include the notification credentials in model-generated text.
  const redact = (text: string) => [url, key].reduce<string>((value, secret) => secret ? value.replaceAll(secret, "[REDACTED]") : value, text);
  const payload = {
    source: "codexctl",
    event,
    key: redact(job.key),
    status: job.status,
    repo: redact(job.repo),
    threadId: job.threadId === null ? null : redact(job.threadId),
    turnId: job.turnId === null ? null : redact(job.turnId),
    at: new Date().toISOString(),
    ...(approvalId === undefined ? {} : { approvalId: redact(approvalId) }),
    finalResponse: Array.from(redact(job.finalResponse)).slice(0, 2000).join(""),
  };
  let failure: { httpStatus: number } | { errorType: string } | undefined;
  try {
    if (!key) {
      failure = { errorType: "missing_key" };
    } else {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (response.status !== 200) failure = { httpStatus: response.status };
      await response.body?.cancel();
    }
  } catch (error) {
    failure = { errorType: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_error" };
  }
  // Notification/audit I/O must never turn a successful job into a failed job.
  await appendEvent(dir, {
    direction: "worker",
    event: { type: failure ? "notify.failed" : "notify.sent", ...failure },
    at: new Date().toISOString(),
  }).catch(() => undefined);
  return failure
    ? { ok: false, error: { code: "notify_failed", message: "httpStatus" in failure ? `HTTP ${failure.httpStatus}` : failure.errorType } }
    : { ok: true };
}
