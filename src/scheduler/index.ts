import type { WebClient } from '@slack/web-api';
import { parseHm } from '../config.js';
import { claimJob, pruneJobRuns } from '../db/jobRuns.js';
import { abandonStaleSessions, getStandup, lastSubmittedBefore } from '../db/standups.js';
import { getStreak } from '../db/streaks.js';
import { listMilestones } from '../db/milestones.js';
import { openTasksBefore, tasksForDay } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { isPaused, listActiveUsers, listBoardChannels, listBoardUsers, workDaysOf } from '../db/users.js';
import { buildReport, rangeFor } from '../domain/report.js';
import { streakBadge } from '../domain/streak.js';
import { closeDanglingSessions } from '../service/attendanceFlow.js';
import { publishHome } from '../service/home.js';
import { beginStandup } from '../service/standupFlow.js';
import { getAttendance } from '../db/attendance.js';
import { boardOpener, boardWrapup } from '../slack/blocks/board.js';
import { COPY } from '../slack/copy.js';
import { blocks, codeBlocks, context, section } from '../slack/blocks/common.js';
import { morningMessage, nudgeMessage, toBullets } from '../slack/blocks/standup.js';
import { postDm, postToBoard } from '../slack/notify.js';
import { log } from '../util/logger.js';
import { addDays, isWorkday, nowInTz, weekdayOf, type Ymd } from '../util/time.js';

/** 프로세스가 잠깐 죽어 있었어도 이 시간(분) 안이면 늦게라도 보낸다 */
const CATCH_UP_MINUTES = 120;

export function startScheduler(client: WebClient): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // 앞 틱이 아직 안 끝났으면 건너뛴다
    running = true;
    try {
      await runCycle(client);
    } catch (err) {
      log.error('스케줄러 틱 실패', err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  log.info('스케줄러 시작 (1분 간격)');
  return () => clearInterval(timer);
}

async function runCycle(client: WebClient): Promise<void> {
  const users = listActiveUsers();
  for (const user of users) {
    try {
      await runForUser(client, user);
    } catch (err) {
      log.error(`스케줄 처리 실패: ${user.slack_user_id}`, err);
    }
  }
  await runBoardJobs(client);
  await runMaintenance(client);
}

/**
 * 공개 보드 채널의 하루 리듬.
 *
 * 개인 대화는 DM 에서만 오간다. 채널에는 "정리 시간이다" 는 시작 신호와
 * 마감 현황만 하루 한 번씩 올린다 — 요약 게시는 각자 제출할 때 따로 올라간다.
 */
async function runBoardJobs(client: WebClient): Promise<void> {
  for (const channelId of listBoardChannels()) {
    try {
      const members = listBoardUsers(channelId).filter((u) => u.share_to_board);
      if (members.length === 0) continue;

      // 날짜·시각 판정은 참여자 타임존 기준. 섞여 있으면 첫 사람을 대표로 본다.
      const lead = members[0]!;
      const now = nowInTz(lead.tz);
      const today = now.date;
      const minutes = now.hour * 60 + now.minute;

      const active = members.filter(
        (u) => isWorkday(today, workDaysOf(u)) && !isPaused(u, today),
      );
      if (active.length === 0) continue;

      // 시작 알림 — 참여자 중 가장 이른 done-next 시각에
      const openAt = active.map((u) => u.standup_time).sort()[0]!;
      if (due(openAt, minutes) && claimJob(`_board:${channelId}`, 'opener', today)) {
        await client.chat.postMessage({
          channel: channelId,
          blocks: boardOpener({ workday: today, participants: active.length }),
          text: `Daily Retro & Planning — ${today}`,
        });
      }

      // 마감 현황 — 가장 늦은 넛지 시각에. 아무도 안 냈으면 올리지 않는다.
      const wrapAt = active.map((u) => u.nudge_time).sort().at(-1)!;
      if (due(wrapAt, minutes)) {
        const submitted = active
          .filter((u) => isSubmitted(u.slack_user_id, today))
          .map((u) => u.slack_user_id);
        if (submitted.length > 0 && claimJob(`_board:${channelId}`, 'wrapup', today)) {
          await client.chat.postMessage({
            channel: channelId,
            blocks: boardWrapup({ workday: today, submitted, total: active.length }),
            text: `${today} 정리 현황`,
          });
        }
      }
    } catch (err) {
      log.error(`보드 채널 처리 실패: ${channelId}`, err);
    }
  }
}

async function runForUser(client: WebClient, user: UserRow): Promise<void> {
  const now = nowInTz(user.tz);
  const today = now.date;
  const workDays = workDaysOf(user);

  if (isPaused(user, today)) return;
  if (!isWorkday(today, workDays)) return;

  const minutes = now.hour * 60 + now.minute;

  // ① 아침 — 어제 하기로 한 일을 먼저 알려 준다
  if (due(user.checkin_time, minutes) && claimJob(user.slack_user_id, 'morning', today)) {
    await sendMorning(client, user, today);
  }

  // ② 저녁 — done-next 대화 시작
  if (due(user.standup_time, minutes) && claimJob(user.slack_user_id, 'standup', today)) {
    await beginStandup(client, user, today);
  }

  // ③ 넛지 — 아직 안 냈으면 한 번만 더
  if (due(user.nudge_time, minutes) && !isSubmitted(user.slack_user_id, today)) {
    if (claimJob(user.slack_user_id, 'nudge', today)) {
      const streak = getStreak(user.slack_user_id).current;
      await postDm(client, user, nudgeMessage(today, streak), '오늘 마무리가 남았습니다.');
    }
  }

  // ④ 주간보고 — 이번 주 마지막 근무일에
  const lastWorkday = Math.max(...workDays);
  if (
    weekdayOf(today) === lastWorkday &&
    due(user.weekly_time, minutes) &&
    claimJob(user.slack_user_id, 'weekly', today)
  ) {
    await sendWeekly(client, user, today);
  }
}

function due(scheduled: string, nowMinutes: number): boolean {
  const { hour, minute } = parseHm(scheduled, '예약 시각');
  const target = hour * 60 + minute;
  const delta = nowMinutes - target;
  return delta >= 0 && delta <= CATCH_UP_MINUTES;
}

function isSubmitted(userId: string, workday: Ymd): boolean {
  return getStandup(userId, workday)?.submitted_at != null;
}

async function sendMorning(client: WebClient, user: UserRow, today: Ymd): Promise<void> {
  const previous = lastSubmittedBefore(user.slack_user_id, today);

  // 오늘 할 일은 어제 NEXT 답변으로 이미 만들어져 있다. 없으면 답변 원문에서 뽑는다.
  const planned = tasksForDay(user.slack_user_id, today)
    .filter((t) => t.status === 'planned')
    .map((t) => t.title);
  const todayPlan = planned.length > 0 ? planned : previous ? toBullets(previous.next_text) : [];

  const streak = getStreak(user.slack_user_id);
  const attendance = getAttendance(user.slack_user_id, today);

  await postDm(
    client,
    user,
    morningMessage({
      name: user.display_name || '동료',
      workday: today,
      yesterday: previous
        ? {
            date: previous.workday,
            done: toBullets(previous.done_text),
            note: previous.note_to_self,
          }
        : null,
      todayPlan,
      carryOver: openTasksBefore(user.slack_user_id, today).slice(0, 5),
      milestones: listMilestones(user.slack_user_id, 'active'),
      streak: streak.current,
      badge: streakBadge(streak.current),
      working: Boolean(attendance?.clock_in && !attendance.clock_out),
    }),
    '좋은 아침입니다.',
  );
  await publishHome(client, user);
}

async function sendWeekly(client: WebClient, user: UserRow, today: Ymd): Promise<void> {
  const report = buildReport(user, 'week', today);
  const range = rangeFor('week', today);

  await postDm(
    client,
    user,
    blocks(
      section(`*이번 주 정리* — ${range.label}`),
      ...codeBlocks(report),
      context('`/report week 공유` 로 채널에 올릴 수 있습니다.'),
    ),
    `${range.label} 주간보고`,
  );

  await postToBoard(
    client,
    user,
    blocks(section(`<@${user.slack_user_id}> 의 *${range.label}* 정리`), ...codeBlocks(report)),
    `${range.label} 주간보고`,
  );
}

/** 하루 한 번 돌리는 청소 — 사용자와 무관한 시스템 잡 */
async function runMaintenance(client: WebClient): Promise<void> {
  const today = nowInTz('UTC').date;
  if (!claimJob('_system', 'maintenance', today)) return;

  // 퇴근을 안 찍은 기록 자동 마감
  for (const closed of closeDanglingSessions(today)) {
    const user = listActiveUsers().find((u) => u.slack_user_id === closed.userId);
    if (user) await postDm(client, user, blocks(section(closed.message)), closed.message);
  }

  abandonStaleSessions(addDays(today, -2));
  pruneJobRuns(addDays(today, -90));
  log.info('일일 정리 완료');
}
