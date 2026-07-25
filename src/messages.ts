/** Attendance punch types and the Teams message each one posts. */

export type PunchType = "start" | "end" | "break" | "resume";

export const PUNCH_TYPES: PunchType[] = ["start", "end", "break", "resume"];

/** The exact text posted to the Teams chat for each punch. */
export const PUNCH_MESSAGES: Record<PunchType, string> = {
  start: "開始します",
  end: "終了します",
  break: "中断します",
  resume: "再開します",
};

/** Short Japanese labels for the UI buttons. */
export const PUNCH_LABELS: Record<PunchType, string> = {
  start: "開始",
  end: "終了",
  break: "中断",
  resume: "再開",
};

export function isPunchType(value: unknown): value is PunchType {
  return typeof value === "string" && (PUNCH_TYPES as string[]).includes(value);
}

export function messageForPunch(type: PunchType): string {
  return PUNCH_MESSAGES[type];
}
