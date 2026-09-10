import { db, nowIso } from './index.js';

export interface CheckinSessionRow {
  user_id: string;
  workday: string;
  stage: 'ask' | 'complete';
  channel_id: string;
  started_at: string;
  updated_at: string;
}

export function getCheckinSession(userId: string, workday: string): CheckinSessionRow | undefined {
  return db()
    .prepare<[string, string], CheckinSessionRow>(
      'SELECT * FROM checkin_sessions WHERE user_id = ? AND workday = ?',
    )
    .get(userId, workday);
}

/** 아직 답을 기다리는 중인 세션 (날짜 무관 — 자정을 넘겨 답해도 이어진다) */
export function openCheckinSession(userId: string): CheckinSessionRow | undefined {
  return db()
    .prepare<[string], CheckinSessionRow>(
      `SELECT * FROM checkin_sessions
       WHERE user_id = ? AND stage != 'complete'
       ORDER BY workday DESC LIMIT 1`,
    )
    .get(userId);
}

export function startCheckinSession(
  userId: string,
  workday: string,
  channelId: string,
): CheckinSessionRow {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO checkin_sessions (user_id, workday, stage, channel_id, started_at, updated_at)
       VALUES (?, ?, 'ask', ?, ?, ?)
       ON CONFLICT(user_id, workday) DO UPDATE SET
         stage = 'ask', channel_id = excluded.channel_id,
         started_at = excluded.started_at, updated_at = excluded.updated_at`,
    )
    .run(userId, workday, channelId, ts, ts);
  return getCheckinSession(userId, workday)!;
}

export function completeCheckinSession(userId: string, workday: string): void {
  db()
    .prepare(
      "UPDATE checkin_sessions SET stage = 'complete', updated_at = ? WHERE user_id = ? AND workday = ?",
    )
    .run(nowIso(), userId, workday);
}

/** 며칠 지나도록 답이 없는 세션은 닫는다 */
export function abandonStaleCheckins(beforeWorkday: string): void {
  db()
    .prepare("UPDATE checkin_sessions SET stage = 'complete' WHERE workday < ? AND stage != 'complete'")
    .run(beforeWorkday);
}
