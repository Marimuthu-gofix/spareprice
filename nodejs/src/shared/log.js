// Tiny logger that prints the same shape as the Python version
// ("2026-09-25 12:00:00,123 INFO spareprice: message"), so the dashboard's
// progress parser and anyone reading Render logs see familiar lines.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function stamp() {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMilliseconds(), 3)}`;
}

function write(level, label, message, error) {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${label} spareprice: ${message}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line + "\n");
  if (error) stream.write((error.stack || String(error)) + "\n");
}

export const log = {
  setLevel(level) {
    threshold = LEVELS[level] ?? threshold;
  },
  debug: (message) => write("debug", "DEBUG", message),
  info: (message) => write("info", "INFO", message),
  warn: (message) => write("warn", "WARNING", message),
  error: (message, error) => write("error", "ERROR", message, error),
  /** Like Python's logger.exception: message plus the stack. */
  exception: (message, error) => write("error", "ERROR", message, error),
};
