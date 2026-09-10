import { db } from './index.js';
import type { StreakRow } from './types.js';

export function getStreak(userId: string): StreakRow {
  const row = db().prepare<[string], StreakRow>('SELECT * FROM streaks WHERE user_id = ?').get(userId);
  if (row) return row;
  db().prepare('INSERT INTO streaks (user_id) VALUES (?)').run(userId);
  return { user_id: userId, current: 0, longest: 0, last_workday: null, total_days: 0 };
}

export function saveStreak(row: StreakRow): void {
  db()
    .prepare(
      `INSERT INTO streaks (user_id, current, longest, last_workday, total_days)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         current = excluded.current,
         longest = excluded.longest,
         last_workday = excluded.last_workday,
         total_days = excluded.total_days`,
    )
    .run(row.user_id, row.current, row.longest, row.last_workday, row.total_days);
}
