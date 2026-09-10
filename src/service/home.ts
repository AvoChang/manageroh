import type { WebClient } from '@slack/web-api';
import { getAttendance } from '../db/attendance.js';
import { listMilestones } from '../db/milestones.js';
import { getStandup } from '../db/standups.js';
import { getStreak } from '../db/streaks.js';
import { tasksForDay } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { minutesSoFar, summarize } from '../domain/attendance.js';
import { streakBadge } from '../domain/streak.js';
import { homeView } from '../slack/blocks/home.js';
import { endOfWeek, startOfWeek } from '../util/time.js';
import { log } from '../util/logger.js';
import { todayFor } from './context.js';

export async function publishHome(client: WebClient, user: UserRow): Promise<void> {
  const today = todayFor(user);
  const attendance = getAttendance(user.slack_user_id, today);
  const week = summarize(user, startOfWeek(today), endOfWeek(today), today, { includeOpen: true });
  const streak = getStreak(user.slack_user_id);

  try {
    await client.views.publish({
      user_id: user.slack_user_id,
      view: {
        type: 'home',
        blocks: homeView({
          user,
          today,
          tasks: tasksForDay(user.slack_user_id, today),
          milestones: listMilestones(user.slack_user_id),
          streak,
          badge: streakBadge(streak.current),
          attendance,
          minutesToday: minutesSoFar(attendance, user.tz),
          weekMinutes: week.totalMinutes,
          standup: getStandup(user.slack_user_id, today),
        }),
      },
    });
  } catch (err) {
    log.warn(`홈 탭 갱신 실패: ${user.slack_user_id}`, err);
  }
}
