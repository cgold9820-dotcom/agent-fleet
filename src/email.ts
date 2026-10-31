import { marked } from "marked";
import nodemailer from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * SMTP settings from the environment. Credentials stay out of command lines
 * and shell history. For Gmail, use smtp.gmail.com:465 with an app password.
 */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Set SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS and optionally MAIL_FROM.`);
  }
  const port = Number(env.SMTP_PORT || 465);
  return {
    host: env.SMTP_HOST!,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM ?? env.SMTP_USER!,
  };
}

const EMAIL_CSS = `body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1c1917;max-width:860px}
table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #e7e5e4;padding:4px 8px;text-align:left}
th{background:#fafaf9}code{background:#f5f5f4;padding:1px 4px;border-radius:3px}`;

/** Render the Markdown report as a self-contained HTML email body. */
export function reportToHtml(markdown: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${EMAIL_CSS}</style></head><body>${body}</body></html>`;
}

export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export function smtpTransport(cfg: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/** Plain address check; also keeps shell metacharacters out of scheduler commands. */
export function assertEmail(addr: string): void {
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr)) throw new Error(`Not a valid email address: "${addr}"`);
}

export async function sendReport(transport: MailTransport, opts: { from: string; to: string; date: string; markdown: string }): Promise<void> {
  await transport.sendMail({
    from: opts.from,
    to: opts.to,
    subject: `Agent fleet report: ${opts.date}`,
    text: opts.markdown,
    html: reportToHtml(opts.markdown),
  });
}

/**
 * The command that registers a daily run with the OS scheduler. On Windows
 * this is Task Scheduler (schtasks); elsewhere a crontab line.
 */
export function scheduleCommand(opts: {
  time: string;
  to: string;
  node: string;
  cli: string;
  /** Extra path flags passed through to the nightly run, e.g. ["--claude-dir", "D:/logs"]. */
  args?: string[];
  platform?: NodeJS.Platform;
}): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(opts.time)) throw new Error(`--time must be HH:MM (24h), got "${opts.time}"`);
  assertEmail(opts.to);
  const args = opts.args ?? [];
  for (const p of [opts.node, opts.cli, ...args]) {
    // Quotes and shell metacharacters would break out of the quoting below (cmd.exe treats \" as a plain quote).
    if (/["'%$`&|<>^\r\n]/.test(p)) throw new Error(`Path not supported in a scheduled command: ${p}`);
    // A trailing backslash would escape the closing quote under Windows argv rules.
    if (/\\$/.test(p)) throw new Error(`Remove the trailing backslash from: ${p}`);
  }
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" && [opts.node, opts.cli, ...args].some((p) => p.includes("\\"))) {
    throw new Error("Paths with a backslash are not supported in a crontab line");
  }
  if (platform === "win32") {
    const extra = args.map((a) => ` \\"${a}\\"`).join("");
    const run = `\\"${opts.node}\\" \\"${opts.cli}\\" email --to ${opts.to}${extra}`;
    // schtasks refuses a /TR longer than 261 characters; say so before running it.
    if (run.replace(/\\"/g, '"').length > 261) throw new Error("The scheduled command is over the 261-character limit of Task Scheduler; use shorter paths");
    return `schtasks /Create /F /SC DAILY /ST ${opts.time} /TN agent-fleet-daily /TR "${run}"`;
  }
  const [h, m] = opts.time.split(":").map(Number);
  const extra = args.map((a) => ` '${a}'`).join("");
  // Replaces an earlier agent-fleet line, so re-running --install does not add a second job.
  const line = `${m} ${h} * * * '${opts.node}' '${opts.cli}' email --to ${opts.to}${extra} # agent-fleet-daily`;
  return `(crontab -l 2>/dev/null | grep -v '# agent-fleet-daily$'; printf '%s\\n' "${line}") | crontab -`;
}
