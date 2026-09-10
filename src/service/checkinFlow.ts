import type { WebClient } from '@slack/web-api';
import type { CheckinSessionRow } from '../db/checkins.js';
import { completeCheckinSession, startCheckinSession } from '../db/checkins.js';
import { listMilestones } from '../db/milestones.js';
import { addTask, deleteTask, openTasksBefore, tasksForDay } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { splitItems } from '../domain/textItems.js';
import { checkinConfirm, checkinPrompt } from '../slack/blocks/checkin.js';
import { dmChannel } from '../slack/notify.js';
import { log } from '../util/logger.js';
import { formatKorean, type Ymd } from '../util/time.js';

/** 줄 끝의 `#12` — 마일스톤 연결 표기 */
const MILESTONE_TAG = /\s*#(\d{1,6})\s*$/;

/**
 * "오늘 할 일" 을 묻는다. 답은 다음 DM 한 통으로 받는다.
 *
 * 모달을 쓰지 않는다 — 제출하면 사라져서 대화에 기록이 안 남기 때문이다.
 * 질문도 답도 확인도 전부 DM 에 그대로 쌓인다.
 */
export async function beginCheckin(
  client: WebClient,
  user: UserRow,
  workday: Ymd,
  channelId?: string,
): Promise<void> {
  const channel = channelId ?? (await dmChannel(client, user));
  if (!channel) {
    log.warn(`체크인을 시작할 DM 채널이 없습니다: ${user.slack_user_id}`);
    return;
  }

  startCheckinSession(user.slack_user_id, workday, channel);

  await client.chat.postMessage({
    channel,
    blocks: checkinPrompt({
      workday,
      carryOver: openTasksBefore(user.slack_user_id, workday).slice(0, 5),
      milestones: listMilestones(user.slack_user_id, 'active'),
    }),
    text: `${formatKorean(workday)} 오늘 할 일을 알려 주세요.`,
  });
}

/**
 * 답변 한 통을 그날의 할 일 목록으로 만든다.
 *
 * 그날의 **계획 상태** 할 일은 통째로 이 답변으로 대체한다.
 * 이미 완료 처리한 것은 건드리지 않는다 — 한 일을 지우면 기록이 거짓말이 된다.
 * 처음 답할 때와 **그 메시지를 나중에 편집했을 때** 둘 다 이 함수를 탄다.
 */
export function saveCheckinTasks(user: UserRow, workday: Ymd, text: string): void {
  const validIds = new Set(listMilestones(user.slack_user_id).map((m) => m.id));

  for (const task of tasksForDay(user.slack_user_id, workday)) {
    if (task.status === 'planned') deleteTask(task.id);
  }

  for (const raw of splitItems(text, 10)) {
    const tag = MILESTONE_TAG.exec(raw);
    const milestoneId = tag && validIds.has(Number(tag[1])) ? Number(tag[1]) : null;
    const title = (milestoneId ? raw.replace(MILESTONE_TAG, '') : raw).trim();
    if (title.length === 0) continue;
    addTask({ userId: user.slack_user_id, workday, title, milestoneId, source: 'checkin' });
  }
}

export async function handleCheckinAnswer(
  client: WebClient,
  user: UserRow,
  session: CheckinSessionRow,
  text: string,
  messageTs?: string,
): Promise<void> {
  const { workday } = session;
  const milestones = listMilestones(user.slack_user_id);

  saveCheckinTasks(user, workday, text);
  completeCheckinSession(user.slack_user_id, workday, messageTs);

  const saved = tasksForDay(user.slack_user_id, workday).filter((t) => t.status !== 'done');
  await client.chat.postMessage({
    channel: session.channel_id,
    blocks: checkinConfirm({
      workday,
      tasks: saved,
      milestoneNames: new Map(milestones.map((m) => [m.id, m.title])),
    }),
    text: `${formatKorean(workday)} 할 일 ${saved.length}개를 등록했습니다.`,
  });
}
