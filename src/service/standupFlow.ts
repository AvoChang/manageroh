import type { WebClient } from '@slack/web-api';
import { getAttendance } from '../db/attendance.js';
import {
  getStandup,
  lastSubmittedBefore,
  markSubmitted,
  saveAnswer,
  setStage,
  startSession,
} from '../db/standups.js';
import { addTask, clearStandupTasks } from '../db/tasks.js';
import type { StandupSessionRow, UserRow } from '../db/types.js';
import { formatDuration, minutesSoFar } from '../domain/attendance.js';
import { expectedNextWorkday, recordStandup, streakBadge } from '../domain/streak.js';
import { getStreak } from '../db/streaks.js';
import { formatKorean, type Ymd } from '../util/time.js';
import { log } from '../util/logger.js';
import {
  boardPost,
  standupClosing,
  standupGreeting,
  standupQuestion1,
  standupQuestion2,
  standupQuestion3,
  toBullets,
} from '../slack/blocks/standup.js';
import { dmChannel, postToBoard } from '../slack/notify.js';
import { COPY } from '../slack/copy.js';

/**
 * done-next 대화를 시작한다.
 *
 * 흐름: 인사 → Q1(오늘 한 일 + 지난 보고 인용) → Q2(내일 할 일) → Q3(나에게 하는 말) → 마무리.
 * 각 답은 사용자가 DM 에 자유 서술로 적는다. 모달을 쓰지 않는 이유는,
 * 답이 대화 기록으로 채널에 남아야 나중에 스스로 훑어볼 수 있기 때문이다.
 */
export async function beginStandup(
  client: WebClient,
  user: UserRow,
  workday: Ymd,
  channelId?: string,
): Promise<void> {
  const channel = channelId ?? (await dmChannel(client, user));
  if (!channel) {
    log.warn(`done-next 를 시작할 DM 채널이 없습니다: ${user.slack_user_id}`);
    return;
  }

  startSession(user.slack_user_id, workday, channel);

  const name = user.display_name || '동료';
  await client.chat.postMessage({
    channel,
    blocks: standupGreeting(name),
    text: COPY.standup.greeting(name),
  });

  const previous = lastSubmittedBefore(user.slack_user_id, workday);
  const quoted = previous ? toBullets(previous.next_text) : [];
  await client.chat.postMessage({
    channel,
    blocks: standupQuestion1(quoted),
    text: COPY.standup.q1,
  });
}

/** 사용자가 DM 에 답을 적었을 때 다음 질문으로 넘긴다. */
export async function handleStandupAnswer(
  client: WebClient,
  user: UserRow,
  session: StandupSessionRow,
  text: string,
): Promise<void> {
  const answer = text.trim();
  if (answer.length === 0) return;

  const { workday } = session;
  const channel = session.channel_id;

  switch (session.stage) {
    case 'q1': {
      saveAnswer(user.slack_user_id, workday, 'done_text', answer);
      setStage(user.slack_user_id, workday, 'q2');
      await client.chat.postMessage({
        channel,
        blocks: standupQuestion2(),
        text: COPY.standup.q2,
      });
      return;
    }
    case 'q2': {
      saveAnswer(user.slack_user_id, workday, 'next_text', answer);
      syncNextDayTasks(user, workday, answer);
      setStage(user.slack_user_id, workday, 'q3');
      await client.chat.postMessage({
        channel,
        blocks: standupQuestion3(),
        text: COPY.standup.q3,
      });
      return;
    }
    case 'q3': {
      saveAnswer(user.slack_user_id, workday, 'note_to_self', answer);
      await finishStandup(client, user, workday, channel);
      return;
    }
    default:
      return;
  }
}

/** NEXT 답변을 다음 근무일의 할 일로 등록한다 — 내일 아침 리마인드의 재료가 된다. */
function syncNextDayTasks(user: UserRow, workday: Ymd, nextText: string): void {
  const target = expectedNextWorkday(user, workday);
  if (!target) return;

  clearStandupTasks(user.slack_user_id, target);
  for (const title of toBullets(nextText, 10)) {
    addTask({ userId: user.slack_user_id, workday: target, title, source: 'standup' });
  }
}

export async function finishStandup(
  client: WebClient,
  user: UserRow,
  workday: Ymd,
  channel: string,
): Promise<void> {
  const standup = markSubmitted(user.slack_user_id, workday);
  const streak = recordStandup(user, workday);
  const badge = streakBadge(streak.current);

  const attendance = getAttendance(user.slack_user_id, workday);
  const minutes = minutesSoFar(attendance, user.tz);
  const workedLabel = minutes === null ? null : formatDuration(minutes);

  const posted = await postToBoard(
    client,
    user,
    boardPost({
      userId: user.slack_user_id,
      workday,
      standup,
      streak: streak.current,
      badge,
      workedLabel,
    }),
    `${user.display_name || '동료'} 의 ${formatKorean(workday)} 마무리`,
  );

  await client.chat.postMessage({
    channel,
    blocks: standupClosing({
      workday,
      streak: streak.current,
      badge,
      workedLabel,
      boardPosted: posted,
    }),
    text: COPY.standup.thanks,
  });

  setStage(user.slack_user_id, workday, 'complete');
}

/** 이미 제출한 날인지 */
export function isSubmitted(userId: string, workday: Ymd): boolean {
  return getStandup(userId, workday)?.submitted_at != null;
}

export function currentStreak(userId: string): number {
  return getStreak(userId).current;
}
