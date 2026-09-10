import type { WebClient } from '@slack/web-api';
import { getAttendance } from '../db/attendance.js';
import {
  getStandup,
  lastSubmittedBefore,
  markSubmitted,
  saveAnswer,
  setBoardMessage,
  setStage,
  startSession,
} from '../db/standups.js';
import { completeMiddaySession } from '../db/middays.js';
import { addTask, clearStandupTasks } from '../db/tasks.js';
import type { StandupRow, StandupSessionRow, UserRow } from '../db/types.js';
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
  // 오후 중간 점검에 답을 안 했으면 여기서 알아서 닫는다 — 이제부터 답은 회고의 것이다.
  completeMiddaySession(user.slack_user_id, workday);

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
  messageTs?: string,
): Promise<void> {
  const answer = text.trim();
  if (answer.length === 0) return;

  const { workday } = session;
  const channel = session.channel_id;

  switch (session.stage) {
    case 'q1': {
      saveAnswer(user.slack_user_id, workday, 'done_text', answer, messageTs);
      setStage(user.slack_user_id, workday, 'q2');
      await client.chat.postMessage({
        channel,
        blocks: standupQuestion2(),
        text: COPY.standup.q2,
      });
      return;
    }
    case 'q2': {
      saveAnswer(user.slack_user_id, workday, 'next_text', answer, messageTs);
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
      saveAnswer(user.slack_user_id, workday, 'note_to_self', answer, messageTs);
      await finishStandup(client, user, workday, channel);
      return;
    }
    default:
      return;
  }
}

/** NEXT 답변을 다음 근무일의 할 일로 등록한다 — 내일 아침 리마인드의 재료가 된다. */
export function syncNextDayTasks(user: UserRow, workday: Ymd, nextText: string): void {
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
    buildBoardBlocks(user, workday, standup),
    `${user.display_name || '동료'} 의 ${formatKorean(workday)} 마무리`,
  );
  if (posted) setBoardMessage(user.slack_user_id, workday, posted.channel, posted.ts);

  await client.chat.postMessage({
    channel,
    blocks: standupClosing({
      workday,
      streak: streak.current,
      badge,
      workedLabel,
      boardPosted: posted !== null,
      stillWorking: Boolean(attendance?.clock_in && !attendance.clock_out),
    }),
    text: COPY.standup.thanks,
  });

  setStage(user.slack_user_id, workday, 'complete');
}

/**
 * 보드 채널에 올릴 요약 블록. 처음 게시할 때와 **답이 수정돼 다시 그릴 때** 둘 다 쓴다.
 * 두 곳이 갈라지면 수정본만 모양이 달라진다.
 */
export function buildBoardBlocks(user: UserRow, workday: Ymd, standup: StandupRow) {
  const streak = getStreak(user.slack_user_id);
  const minutes = minutesSoFar(getAttendance(user.slack_user_id, workday), user.tz);
  return boardPost({
    userId: user.slack_user_id,
    workday,
    standup,
    streak: streak.current,
    badge: streakBadge(streak.current),
    workedLabel: minutes === null ? null : formatDuration(minutes),
  });
}

/** 이미 제출한 날인지 */
export function isSubmitted(userId: string, workday: Ymd): boolean {
  return getStandup(userId, workday)?.submitted_at != null;
}

export function currentStreak(userId: string): number {
  return getStreak(userId).current;
}
