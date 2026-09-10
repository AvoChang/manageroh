import type { WebClient } from '@slack/web-api';
import { listMilestones } from '../db/milestones.js';
import { completeMiddaySession, startMiddaySession, type MiddaySessionRow } from '../db/middays.js';
import { addTask, setTaskStatus, tasksForDay } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { splitItems } from '../domain/textItems.js';
import { middayConfirm, middayPrompt } from '../slack/blocks/midday.js';
import { COPY } from '../slack/copy.js';
import { dmChannel } from '../slack/notify.js';
import { log } from '../util/logger.js';
import { formatKorean, type Ymd } from '../util/time.js';

/** 제목 비교용 — 공백과 대소문자 차이는 무시한다 */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ProgressResult {
  completed: string[];
  added: string[];
}

/**
 * 진행 보고 한 통을 오늘 현황에 반영한다.
 *
 * 한 줄이 계획에 있던 일이면 **그걸 완료 처리**하고, 없던 일이면 `/done` 처럼 새로 기록한다.
 * 이름이 정확히 같지 않아도 한쪽이 다른 쪽을 포함하고 후보가 하나뿐이면 같은 것으로 본다
 * ("인강" → "인강 3강"). 후보가 여럿이면 헷갈리므로 새 항목으로 넣고 확인 메시지에 드러낸다.
 *
 * 같은 답변을 다시 반영해도(메시지 수정) 완료된 것이 중복으로 쌓이지 않는다.
 */
export function applyProgressUpdate(user: UserRow, workday: Ymd, text: string): ProgressResult {
  const result: ProgressResult = { completed: [], added: [] };
  const rows = tasksForDay(user.slack_user_id, workday);
  const planned = rows.filter((t) => t.status === 'planned');
  const alreadyDone = new Set(rows.filter((t) => t.status === 'done').map((t) => normalize(t.title)));
  const used = new Set<number>();

  for (const line of splitItems(text, 15)) {
    const key = normalize(line);
    if (key.length === 0) continue;

    const available = planned.filter((t) => !used.has(t.id));
    const exact = available.find((t) => normalize(t.title) === key);
    const loose = available.filter(
      (t) => normalize(t.title).includes(key) || key.includes(normalize(t.title)),
    );
    const match = exact ?? (loose.length === 1 ? loose[0] : undefined);

    if (match) {
      setTaskStatus(match.id, 'done');
      used.add(match.id);
      result.completed.push(match.title);
      continue;
    }

    if (alreadyDone.has(key)) continue; // 수정본을 다시 반영해도 중복으로 안 쌓인다
    addTask({ userId: user.slack_user_id, workday, title: line, status: 'done', source: 'done' });
    alreadyDone.add(key);
    result.added.push(line);
  }

  return result;
}

export async function beginMidday(
  client: WebClient,
  user: UserRow,
  workday: Ymd,
  channelId?: string,
): Promise<void> {
  const channel = channelId ?? (await dmChannel(client, user));
  if (!channel) {
    log.warn(`중간 점검을 보낼 DM 채널이 없습니다: ${user.slack_user_id}`);
    return;
  }

  startMiddaySession(user.slack_user_id, workday, channel);

  await client.chat.postMessage({
    channel,
    blocks: middayPrompt({
      workday,
      tasks: tasksForDay(user.slack_user_id, workday),
      milestones: listMilestones(user.slack_user_id, 'active'),
    }),
    text: COPY.midday.question,
  });
}

export async function handleMiddayAnswer(
  client: WebClient,
  user: UserRow,
  session: MiddaySessionRow,
  text: string,
  messageTs?: string,
): Promise<void> {
  const { workday } = session;
  const result = applyProgressUpdate(user, workday, text);
  completeMiddaySession(user.slack_user_id, workday, messageTs);

  await client.chat.postMessage({
    channel: session.channel_id,
    blocks: middayConfirm({
      workday,
      completed: result.completed,
      added: result.added,
      tasks: tasksForDay(user.slack_user_id, workday),
      milestones: listMilestones(user.slack_user_id),
    }),
    text: `${formatKorean(workday)} 현황을 갱신했습니다.`,
  });
}
