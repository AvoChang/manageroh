import { db, nowIso } from './index.js';
import type { StandupRow, StandupSessionRow, StandupStage } from './types.js';

export function getStandup(userId: string, workday: string): StandupRow | undefined {
  return db()
    .prepare<[string, string], StandupRow>('SELECT * FROM standups WHERE user_id = ? AND workday = ?')
    .get(userId, workday);
}

/** 행이 없으면 빈 채로 만든다 — 질문에 하나씩 답할 때마다 부분 저장하기 위해서다. */
function ensureRow(userId: string, workday: string): void {
  db()
    .prepare('INSERT OR IGNORE INTO standups (user_id, workday) VALUES (?, ?)')
    .run(userId, workday);
}

export type StandupField = 'done_text' | 'next_text' | 'note_to_self' | 'blocker_text';

export function saveAnswer(
  userId: string,
  workday: string,
  field: StandupField,
  text: string,
): void {
  ensureRow(userId, workday);
  db()
    .prepare(`UPDATE standups SET ${field} = ? WHERE user_id = ? AND workday = ?`)
    .run(text.trim(), userId, workday);
}

export function markSubmitted(userId: string, workday: string): StandupRow {
  ensureRow(userId, workday);
  db()
    .prepare('UPDATE standups SET submitted_at = ? WHERE user_id = ? AND workday = ?')
    .run(nowIso(), userId, workday);
  return getStandup(userId, workday)!;
}

export function standupsInRange(userId: string, from: string, to: string): StandupRow[] {
  return db()
    .prepare<[string, string, string], StandupRow>(
      'SELECT * FROM standups WHERE user_id = ? AND workday BETWEEN ? AND ? ORDER BY workday',
    )
    .all(userId, from, to);
}

/** 직전에 제출된 보고 — 아침 리마인드와 "In your previous report" 인용에 쓴다 */
export function lastSubmittedBefore(userId: string, workday: string): StandupRow | undefined {
  return db()
    .prepare<[string, string], StandupRow>(
      `SELECT * FROM standups
       WHERE user_id = ? AND workday < ? AND submitted_at IS NOT NULL
       ORDER BY workday DESC LIMIT 1`,
    )
    .get(userId, workday);
}

// ── done-next 대화 세션 ─────────────────────────────────────────────

export function getSession(userId: string, workday: string): StandupSessionRow | undefined {
  return db()
    .prepare<[string, string], StandupSessionRow>(
      'SELECT * FROM standup_sessions WHERE user_id = ? AND workday = ?',
    )
    .get(userId, workday);
}

/** 아직 답을 기다리는 중인 세션 (날짜 무관 — 자정 넘겨 답해도 이어진다) */
export function openSession(userId: string): StandupSessionRow | undefined {
  return db()
    .prepare<[string], StandupSessionRow>(
      `SELECT * FROM standup_sessions
       WHERE user_id = ? AND stage != 'complete'
       ORDER BY workday DESC LIMIT 1`,
    )
    .get(userId);
}

export function startSession(userId: string, workday: string, channelId: string): StandupSessionRow {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO standup_sessions (user_id, workday, stage, channel_id, started_at, updated_at)
       VALUES (?, ?, 'q1', ?, ?, ?)
       ON CONFLICT(user_id, workday) DO UPDATE SET
         stage = 'q1', channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
    )
    .run(userId, workday, channelId, ts, ts);
  return getSession(userId, workday)!;
}

export function setStage(userId: string, workday: string, stage: StandupStage): void {
  db()
    .prepare('UPDATE standup_sessions SET stage = ?, updated_at = ? WHERE user_id = ? AND workday = ?')
    .run(stage, nowIso(), userId, workday);
}

/** 어제 세션이 q1 에 멈춰 있는 채로 새 날이 오면 정리한다 */
export function abandonStaleSessions(beforeWorkday: string): void {
  db()
    .prepare("UPDATE standup_sessions SET stage = 'complete' WHERE workday < ? AND stage != 'complete'")
    .run(beforeWorkday);
}
