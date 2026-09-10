import { db } from './index.js';
import type { AttendanceRow } from './types.js';

export function getAttendance(userId: string, workday: string): AttendanceRow | undefined {
  return db()
    .prepare<[string, string], AttendanceRow>(
      'SELECT * FROM attendance WHERE user_id = ? AND workday = ?',
    )
    .get(userId, workday);
}

export function upsertAttendance(row: AttendanceRow): void {
  db()
    .prepare(
      `INSERT INTO attendance (user_id, workday, clock_in, clock_out, break_minutes, worked_minutes, auto_closed)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workday) DO UPDATE SET
         clock_in = excluded.clock_in,
         clock_out = excluded.clock_out,
         break_minutes = excluded.break_minutes,
         worked_minutes = excluded.worked_minutes,
         auto_closed = excluded.auto_closed`,
    )
    .run(
      row.user_id,
      row.workday,
      row.clock_in,
      row.clock_out,
      row.break_minutes,
      row.worked_minutes,
      row.auto_closed,
    );
}

export function attendanceInRange(userId: string, from: string, to: string): AttendanceRow[] {
  return db()
    .prepare<[string, string, string], AttendanceRow>(
      'SELECT * FROM attendance WHERE user_id = ? AND workday BETWEEN ? AND ? ORDER BY workday',
    )
    .all(userId, from, to);
}

/** 퇴근을 안 찍고 남아 있는 기록 — 자동 마감 대상 */
export function danglingSessions(beforeWorkday: string): AttendanceRow[] {
  return db()
    .prepare<[string], AttendanceRow>(
      `SELECT * FROM attendance
       WHERE clock_in IS NOT NULL AND clock_out IS NULL AND workday < ?`,
    )
    .all(beforeWorkday);
}
