import { getAttendance } from '../db/attendance.js';
import type { UserRow } from '../db/types.js';
import {
  autoClose,
  clockIn,
  clockOut,
  danglingBefore,
  formatDuration,
  localTime,
  minutesSoFar,
} from '../domain/attendance.js';
import { getUser } from '../db/users.js';
import { COPY } from '../slack/copy.js';
import { todayFor } from './context.js';

export function doClockIn(user: UserRow, at: Date = new Date()): string {
  const workday = todayFor(user, at);
  const result = clockIn(user.slack_user_id, workday, at);
  const time = localTime(result.row.clock_in!, user.tz);

  if (result.alreadyIn) return COPY.attendance.alreadyIn(time);
  if (result.resumed) return COPY.attendance.resumed(time);
  return COPY.attendance.clockedIn(time);
}

export function doClockOut(user: UserRow, at: Date = new Date()): string {
  const workday = todayFor(user, at);
  const row = clockOut(user.slack_user_id, workday, user.tz, at);
  if (!row) return COPY.attendance.noClockIn;

  return COPY.attendance.clockedOut(
    localTime(row.clock_out!, user.tz),
    formatDuration(row.worked_minutes ?? 0),
    row.break_minutes,
  );
}

export function isWorkingNow(user: UserRow, at: Date = new Date()): boolean {
  const row = getAttendance(user.slack_user_id, todayFor(user, at));
  return Boolean(row?.clock_in && !row.clock_out);
}

export function minutesToday(user: UserRow, at: Date = new Date()): number | null {
  return minutesSoFar(getAttendance(user.slack_user_id, todayFor(user, at)), user.tz, at);
}

/**
 * 퇴근을 안 찍고 날이 바뀐 기록을 정리한다.
 * 안 하면 "지금까지 37시간 근무" 같은 값이 보고서에 들어간다.
 */
export function closeDanglingSessions(beforeWorkday: string): { userId: string; message: string }[] {
  const results: { userId: string; message: string }[] = [];
  for (const row of danglingBefore(beforeWorkday)) {
    const user = getUser(row.user_id);
    if (!user) continue;
    const closed = autoClose(row, user.tz);
    results.push({
      userId: row.user_id,
      message: COPY.attendance.autoClosed(row.workday, formatDuration(closed.worked_minutes ?? 0)),
    });
  }
  return results;
}
