// ---------------------------------------------------------------------------
// Session Logger — persists rebalance progress to active_session.json so
// the operator can tell at a glance where a run was interrupted.
// ---------------------------------------------------------------------------

import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(__dirname, "../../active_session.json");

export type RebalanceStep = "WITHDRAW" | "SWAP" | "MINT";

export interface SessionData {
  step: RebalanceStep;
  startTime: string;
  targetRange: { tickLower: number; tickUpper: number };
  updatedAt: string;
}

export function writeSession(
  step: RebalanceStep,
  targetRange: { tickLower: number; tickUpper: number },
  startTime?: string,
): void {
  const now = new Date().toISOString();
  const prev = readSession();

  const data: SessionData = {
    step,
    startTime: startTime ?? prev?.startTime ?? now,
    targetRange,
    updatedAt: now,
  };

  try {
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.warn("[SessionLogger] failed to write session:", err);
  }
}

export function clearSession(): void {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    // already gone — fine
  }
}

export function readSession(): SessionData | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}
