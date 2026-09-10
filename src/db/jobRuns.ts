import { db, nowIso } from './index.js';

/**
 * 잡을 오늘 아직 안 돌렸으면 표시하고 true 를 준다. 이미 돌렸으면 false.
 * INSERT 의 원자성에 기대므로 프로세스가 둘이어도 중복 발송되지 않는다.
 */
export function claimJob(userId: string, job: string, workday: string): boolean {
  const result = db()
    .prepare(
      'INSERT OR IGNORE INTO job_runs (user_id, job, workday, ran_at) VALUES (?, ?, ?, ?)',
    )
    .run(userId, job, workday, nowIso());
  return result.changes > 0;
}

export function hasRun(userId: string, job: string, workday: string): boolean {
  const row = db()
    .prepare<[string, string, string], { c: number }>(
      'SELECT COUNT(*) AS c FROM job_runs WHERE user_id = ? AND job = ? AND workday = ?',
    )
    .get(userId, job, workday);
  return (row?.c ?? 0) > 0;
}

/** 오래된 기록 청소 — 90일치만 남긴다 */
export function pruneJobRuns(before: string): void {
  db().prepare('DELETE FROM job_runs WHERE workday < ?').run(before);
}
