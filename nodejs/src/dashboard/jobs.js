// Runs the scraper as a child process and tracks its progress for the page.
// Ported from the job_state / start_job / run_tracker_command part of dashboard.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { utcNow } from "../shared/text.js";
import { dbPath, releasePriceData, ROOT } from "./data.js";

export const SCRAPE_BRANDS = new Set(["all", "apple", "samsung", "oppo", "realme", "oneplus", "mi", "vivo", "iqoo", "motorola", "cashify"]);

function defaultConfig() {
  if (process.env.CONFIG_PATH) return path.resolve(process.env.CONFIG_PATH);
  const local = path.join(ROOT, "config.json");
  const parent = path.join(ROOT, "..", "config.json");
  return !fs.existsSync(local) && fs.existsSync(parent) ? parent : local;
}

const jobState = {
  id: null, running: false, started_at: null, finished_at: null, returncode: null, message: "Ready", output: "",
  progress: { done: 0, rows: 0, errors: 0, current: "", scope: "" },
};

export function currentJobState() {
  return { ...jobState, progress: { ...jobState.progress } };
}

/** How many brand crawls a dashboard-started scrape runs at once (1 on Render). */
export function scrapeParallelism() {
  const configured = (process.env.SCRAPE_PARALLEL || "").trim();
  if (/^\d+$/.test(configured) && Number(configured) > 0) return configured;
  return process.env.RENDER ? "1" : "4";
}

const DISCOVERED_RE = /Discovered\s+(Apple|Asus|Google|Honor|Infinix|Nothing|Nokia|OPPO|POCO|Samsung|Xiaomi|realme|OnePlus|Mi|vivo|iQOO|Motorola|Cashify)\s+(.+?)\s+\((?:(\d+)\s+rows,\s+)?(\d+)\/([^)]+)\)/;
const CHECKING_RE = /Checking\s+(\d+)\/(\d+):\s+(.+)$/;
const SAVED_RE = /Saved\s+(\S+)\s+(.+?):/;

function updateJobProgress(line, output) {
  const progress = { ...jobState.progress };
  const discovered = DISCOVERED_RE.exec(line);
  if (discovered) {
    const [, brand, model, rows, count] = discovered;
    progress.done = Number(count);
    progress.current = model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
    if (rows) progress.rows += Number(rows);
  }
  const checking = CHECKING_RE.exec(line);
  if (checking) {
    progress.done = Number(checking[1]) - 1;
    progress.current = checking[3];
  }
  const saved = SAVED_RE.exec(line);
  if (saved) {
    progress.done += 1;
    progress.rows += 1;
    progress.current = `${saved[1]} ${saved[2]}`;
  }
  const lower = line.toLowerCase();
  if (` ${line} `.includes(" ERROR ") || lower.includes(" discovery failed") || lower.includes(" failed:")) progress.errors += 1;
  jobState.progress = progress;
  jobState.output = output;
}

export function startJob(jobType, brand = "all", model = "") {
  if (jobState.running) return false;
  let message = "Checking all configured devices...";
  if (jobType === "catalog") {
    let scope = brand === "all" ? "all brands" : brand;
    if (model) scope += ` matching ${model}`;
    message = `Discovering ${scope} model and spare-part prices...`;
  }
  Object.assign(jobState, {
    id: randomUUID(), running: true, started_at: utcNow(), finished_at: null, returncode: null, message, output: "",
    progress: { done: 0, rows: 0, errors: 0, current: "", scope: message },
  });
  releasePriceData();
  runTrackerCommand(jobType, brand, model);
  return true;
}

function runTrackerCommand(jobType, brand, model) {
  const cli = path.join(ROOT, "src", "scraper", "cli.js");
  const args = jobType === "catalog"
    ? [cli, "discover-all", "--brand", brand, "--delay", "1", "--parallel", scrapeParallelism(), ...(model ? ["--model", model] : [])]
    : [cli, "run", "--config", defaultConfig()];
  let child;
  try {
    child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath() }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    finish(-1, `Price check failed: ${error.name}`, String(error));
    return;
  }
  const outputLines = [];
  let pending = "";
  const consume = (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const raw of lines) {
      const clean = raw.trim();
      if (!clean) continue;
      outputLines.push(clean);
      if (outputLines.length > 200) outputLines.splice(0, outputLines.length - 200);
      updateJobProgress(clean, outputLines.join("\n").slice(-6000));
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.on("error", (error) => finish(-1, `Price check failed: ${error.name}`, String(error)));
  child.on("close", (code) => {
    if (pending.trim()) consume("\n");
    const output = outputLines.join("\n").trim();
    let message = code === 0 ? "Price check complete" : "Price check finished with errors";
    if (jobType === "catalog") message = code === 0 ? "Catalog discovery complete" : "Catalog discovery finished with errors";
    finish(code ?? -1, message, output.slice(-6000));
  });
}

function finish(returncode, message, output) {
  Object.assign(jobState, { running: false, finished_at: utcNow(), returncode, message, output });
}
