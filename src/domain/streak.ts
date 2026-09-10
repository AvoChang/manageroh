import { getStreak, saveStreak } from '../db/streaks.js';
import type { StreakRow, UserRow } from '../db/types.js';
import { isPaused, workDaysOf } from '../db/users.js';
import { addDays, isWorkday, type Ymd } from '../util/time.js';

/**
 * 스탠드업을 제출했을 때 연속기록을 갱신한다.
 *
 * "연속"의 기준은 **근무일**이다. 주말·일시정지(휴가) 기간은 건너뛴다 —
 * 쉬는 날 때문에 기록이 끊기면 쉬는 게 벌이 되고, 그건 이 앱의 취지와 반대다.
 */
export function recordStandup(user: UserRow, workday: Ymd): StreakRow {
  const streak = getStreak(user.slack_user_id);
  if (streak.last_workday === workday) return streak; // 같은 날 재제출

  const continues =
    streak.last_workday !== null &&
    expectedNextWorkday(user, streak.last_workday) === workday;

  const current = continues ? streak.current + 1 : 1;
  const next: StreakRow = {
    user_id: user.slack_user_id,
    current,
    longest: Math.max(current, streak.longest),
    last_workday: workday,
    total_days: streak.total_days + 1,
  };
  saveStreak(next);
  return next;
}

/**
 * `from` 다음에 오는 "출근했어야 하는 날".
 * 근무요일이 아니거나 휴가로 잡아둔 날은 건너뛴다.
 */
export function expectedNextWorkday(user: UserRow, from: Ymd): Ymd | null {
  const workDays = workDaysOf(user);
  for (let i = 1; i <= 31; i++) {
    const candidate = addDays(from, i);
    if (!isWorkday(candidate, workDays)) continue;
    if (isPaused(user, candidate)) continue;
    return candidate;
  }
  return null;
}

/** 오늘 기준으로 연속기록이 이미 끊겼는지 (제출 전 상태 표시용) */
export function isStreakBroken(user: UserRow, today: Ymd): boolean {
  const streak = getStreak(user.slack_user_id);
  if (streak.last_workday === null) return false;
  const expected = expectedNextWorkday(user, streak.last_workday);
  return expected !== null && expected < today;
}

export function streakBadge(current: number): string {
  if (current >= 100) return '🏆';
  if (current >= 30) return '🔥🔥🔥';
  if (current >= 10) return '🔥🔥';
  if (current >= 3) return '🔥';
  if (current >= 1) return '✨';
  return '·';
}
