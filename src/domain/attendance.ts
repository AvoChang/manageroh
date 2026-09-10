import { config } from '../config.js';
import { attendanceInRange, danglingSessions, getAttendance, upsertAttendance } from '../db/attendance.js';
import type { AttendanceRow, UserRow } from '../db/types.js';
import { workDaysOf } from '../db/users.js';
import { isWorkday, zonedToUtc, type Ymd } from '../util/time.js';

export interface ClockResult {
  row: AttendanceRow;
  /** 이미 그 상태였는지 (중복 클릭) */
  alreadyIn?: boolean;
  /** 퇴근 기록을 취소하고 다시 근무 시작했는지 */
  resumed?: boolean;
}

export function clockIn(userId: string, workday: Ymd, at: Date = new Date()): ClockResult {
  const existing = getAttendance(userId, workday);

  if (existing?.clock_in && !existing.clock_out) {
    return { row: existing, alreadyIn: true };
  }

  if (existing?.clock_in && existing.clock_out) {
    // 퇴근을 찍었다가 다시 일을 시작한 경우 — 원래 출근 시각은 유지하고 퇴근만 취소한다.
    const resumed: AttendanceRow = {
      ...existing,
      clock_out: null,
      worked_minutes: null,
      break_minutes: 0,
      auto_closed: 0,
    };
    upsertAttendance(resumed);
    return { row: resumed, resumed: true };
  }

  const row: AttendanceRow = {
    user_id: userId,
    workday,
    clock_in: at.toISOString(),
    clock_out: null,
    break_minutes: 0,
    worked_minutes: null,
    auto_closed: 0,
  };
  upsertAttendance(row);
  return { row };
}

export function clockOut(
  userId: string,
  workday: Ymd,
  tz: string,
  at: Date = new Date(),
): AttendanceRow | null {
  const existing = getAttendance(userId, workday);
  if (!existing?.clock_in) return null;

  const closed = withWorkedTime(existing, at.toISOString(), tz, false);
  upsertAttendance(closed);
  return closed;
}

/**
 * 퇴근을 안 찍은 기록을 **정규 퇴근 시각**(기본 18:00)으로 마감한다.
 *
 * 예전에는 "최대 근무시간"으로 잘라서 잠깐 일한 날이 13시간으로 남았다.
 * 모르는 값을 크게 잡는 것보다 정규 근무일로 두는 편이 통계를 덜 망친다.
 * 출근 기록이 아예 없는 날은 이 함수를 타지 않으므로 그대로 0 시간이다.
 */
export function autoClose(row: AttendanceRow, tz: string): AttendanceRow {
  const start = new Date(row.clock_in!).getTime();
  const regular = zonedToUtc(row.workday, config.attendance.defaultClockOut, tz).getTime();

  // 정규 퇴근 시각을 이미 지나서 출근한 날은 시각으로 마감할 수 없다 — 길이로 대신한다.
  const end =
    regular > start ? regular : start + config.attendance.defaultWorkHours * 3_600_000;

  const closed = withWorkedTime(row, new Date(end).toISOString(), tz, true);
  upsertAttendance(closed);
  return closed;
}

/**
 * 근무 구간과 점심 구간이 **겹치는 만큼만** 뺀다.
 *
 * 점심은 길이가 아니라 시각 구간(기본 12:30~14:00)이다.
 * 오전에만 일하고 간 날에 1시간 30분을 빼면 근무시간이 음수에 가까워진다.
 */
export function computeWorked(
  clockInIso: string,
  clockOutIso: string,
  workday: Ymd,
  tz: string,
): { breakMinutes: number; workedMinutes: number } {
  const start = new Date(clockInIso).getTime();
  const end = new Date(clockOutIso).getTime();
  const rawMinutes = Math.max(0, Math.round((end - start) / 60_000));

  const lunchStart = zonedToUtc(workday, config.attendance.lunchStart, tz).getTime();
  const lunchEnd = zonedToUtc(workday, config.attendance.lunchEnd, tz).getTime();
  const overlap = Math.max(
    0,
    Math.round((Math.min(end, lunchEnd) - Math.max(start, lunchStart)) / 60_000),
  );

  return { breakMinutes: overlap, workedMinutes: Math.max(0, rawMinutes - overlap) };
}

function withWorkedTime(
  row: AttendanceRow,
  clockOutIso: string,
  tz: string,
  auto: boolean,
): AttendanceRow {
  const { breakMinutes, workedMinutes } = computeWorked(
    row.clock_in!,
    clockOutIso,
    row.workday,
    tz,
  );
  return {
    ...row,
    clock_out: clockOutIso,
    break_minutes: breakMinutes,
    worked_minutes: workedMinutes,
    auto_closed: auto ? 1 : 0,
  };
}

/** `/근무 수정` — 출퇴근 시각을 손으로 바로잡는다 */
export function setManualAttendance(
  userId: string,
  workday: Ymd,
  clockInIso: string,
  clockOutIso: string,
  tz: string,
): AttendanceRow {
  const { breakMinutes, workedMinutes } = computeWorked(clockInIso, clockOutIso, workday, tz);
  const row: AttendanceRow = {
    user_id: userId,
    workday,
    clock_in: clockInIso,
    clock_out: clockOutIso,
    break_minutes: breakMinutes,
    worked_minutes: workedMinutes,
    auto_closed: 0,
  };
  upsertAttendance(row);
  return row;
}

/** 퇴근 전이라도 "지금까지 몇 시간" 을 보여주기 위한 추정치 */
export function minutesSoFar(
  row: AttendanceRow | undefined,
  tz: string,
  now: Date = new Date(),
): number | null {
  if (!row?.clock_in) return null;
  if (row.worked_minutes !== null) return row.worked_minutes;
  return computeWorked(row.clock_in, now.toISOString(), row.workday, tz).workedMinutes;
}

/** 퇴근을 안 찍고 남아 있는 기록 (자동 마감 대상) */
export function danglingBefore(workday: Ymd): AttendanceRow[] {
  return danglingSessions(workday);
}

export interface AttendanceSummary {
  totalMinutes: number;
  days: number;
  averageMinutes: number;
  /** 근무일인데 출근 기록이 없는 날 수 (오늘 이후는 세지 않음) */
  missingDays: number;
  rows: AttendanceRow[];
}

/**
 * @param includeOpen 아직 퇴근을 안 찍은 날도 "지금까지" 로 세어 넣는다.
 *   대시보드처럼 살아 있는 화면에서는 켠다 — 근무 중인데 합계가 0 이면 이상하다.
 *   보고서는 끈다 — 확정된 값만 담아야 한다.
 */
export function summarize(
  user: UserRow,
  from: Ymd,
  to: Ymd,
  today: Ymd,
  options: { includeOpen?: boolean; now?: Date } = {},
): AttendanceSummary {
  const rows = attendanceInRange(user.slack_user_id, from, to);
  const now = options.now ?? new Date();
  const counted = rows.filter(
    (r) => r.worked_minutes !== null || (options.includeOpen === true && r.clock_in !== null),
  );
  const totalMinutes = counted.reduce(
    (sum, r) => sum + (r.worked_minutes ?? minutesSoFar(r, user.tz, now) ?? 0),
    0,
  );

  const workDays = workDaysOf(user);
  const end = to < today ? to : today;
  let expected = 0;
  let cursor = from;
  while (cursor <= end) {
    if (isWorkday(cursor, workDays)) expected++;
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }

  return {
    totalMinutes,
    days: counted.length,
    averageMinutes: counted.length === 0 ? 0 : Math.round(totalMinutes / counted.length),
    missingDays: Math.max(0, expected - rows.length),
    rows,
  };
}

/** 610 → '10시간 10분'. 기록이 없는 날은 '0시간'. */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0시간';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** ISO(UTC) → 사용자 타임존의 'HH:MM' */
export function localTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
