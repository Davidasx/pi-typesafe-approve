/**
 * Append-only JSONL log of every gate decision.
 *
 * The file lives next to the config at
 * `<agentDir>/extensions/pi-typesafe-approve/decisions.jsonl`, is created with
 * owner-only permissions, and never contains the API key.
 *
 * ## Size cap
 *
 * An append-only file grows without bound, so the log is trimmed from the front
 * once it passes {@link LOG_MAX_BYTES} (20 MB). Trimming keeps the newest
 * {@link LOG_KEEP_BYTES} (10 MB) and drops the rest, so it runs once per ~10 MB
 * of growth rather than on every write.
 *
 * Both numbers are fixed in code. Log retention is not a decision anyone wants
 * to make: 10 MB is roughly 3400 entries at ~3 KB each, which is enough to look
 * back over a session or tune a threshold, and a trim costs one read plus one
 * write of 10 MB every ~3400 commands. A knob here would only be a way to
 * configure a problem.
 *
 * The trim reads only the tail it is going to keep — an offset-based read of
 * 10 MB, not the whole file — so memory stays bounded no matter how large the log
 * got. It then writes that tail to a temporary file and renames it over the
 * original, which is atomic on the same filesystem: a reader either sees the old
 * complete file or the new one, never a half-written log. The tail is rounded
 * down to a record boundary, so the new file still begins with a whole entry.
 *
 * Every step is wrapped so a failure skips the trim instead of breaking the
 * gate. Losing log history is acceptable; blocking a command because of it is
 * not.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "./types.ts";

/** Trim `decisions.jsonl` once it passes this size. */
export const LOG_MAX_BYTES = 20 * 1024 * 1024;
/** What a trim keeps, counted from the newest entry backwards. */
export const LOG_KEEP_BYTES = LOG_MAX_BYTES / 2;

export interface DecisionLogRecord {
  time: string;
  command: string;
  cwd: string;
  verdict: Decision["verdict"];
  action:
    | "allow"
    | "block"
    | "monitor"
    | "no-ui-allow"
    | "fail-open";
  reasons: string[];
  signals: Decision["signals"];
  model?: string;
  usage?: Decision["usage"];
  cached?: boolean;
  degraded?: Decision["degraded"];
  durationMs?: number;
  source?: string;
}

export interface DecisionLogger {
  record(entry: DecisionLogRecord): void;
  debug(event: string, details?: Record<string, unknown>): void;
}

/** A logger that writes nothing; used when logging is disabled or in tests. */
export const nullLogger: DecisionLogger = {
  record: () => {},
  debug: () => {},
};

/**
 * The size arguments exist for tests only; they are not configuration. Real
 * callers use the fixed {@link LOG_MAX_BYTES} / {@link LOG_KEEP_BYTES}.
 */
export function createFileLogger(
  filePath: string,
  debugEnabled: () => boolean,
  maxBytes: number = LOG_MAX_BYTES,
  keepBytes: number = LOG_KEEP_BYTES,
): DecisionLogger {
  let directoryReady = false;

  const ensureDirectory = (): void => {
    if (directoryReady) return;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    directoryReady = true;
  };

  const write = (value: unknown): void => {
    try {
      ensureDirectory();
      trimLogFile(filePath, maxBytes, keepBytes);
      appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A log write must never break the gate.
    }
  };

  return {
    record: (entry) => write(entry),
    debug: (event, details) => {
      if (!debugEnabled()) return;
      write({ time: new Date().toISOString(), debug: event, ...(details ?? {}) });
    },
  };
}

/**
 * If `filePath` is bigger than `maxBytes`, keep its newest `keepBytes`, rounded
 * down to a whole line, and drop everything before that. Never throws.
 */
export function trimLogFile(
  filePath: string,
  maxBytes: number = LOG_MAX_BYTES,
  keepBytes: number = LOG_KEEP_BYTES,
): void {
  if (!(maxBytes > 0) || !(keepBytes > 0)) return;

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    // No log yet, or it cannot be stat-ed. Either way there is nothing to trim.
    return;
  }
  if (size <= maxBytes) return;
  const keep = Math.max(1, Math.floor(keepBytes));
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const length = Math.min(keep, size);
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);

    // Cut at a record boundary so the new file still begins with a whole entry.
    // Two cases fall back to keeping the window exactly as read: no newline at
    // all, and a first newline that is the window's last byte — the latter means
    // the only record boundary inside the window is at its very end, so cutting
    // there would leave an empty file and throw away all history. Both mean a
    // single record larger than the window, which for one JSON object per line
    // does not happen in practice; never emptying the file matters more than the
    // exact size.
    const window = buffer.subarray(0, read);
    const firstNewline = window.indexOf(0x0a);
    const tail = firstNewline === -1 || firstNewline + 1 >= read
      ? window
      : window.subarray(firstNewline + 1);

    const temporary = `${filePath}.trim`;
    writeFileSync(temporary, tail, { mode: 0o600 });
    renameSync(temporary, filePath);
  } catch {
    // Nothing to do: the next write will try again.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or gone.
      }
    }
  }
}
