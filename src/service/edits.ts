import type { WebClient } from '@slack/web-api';
import { findCheckinByAnswerTs } from '../db/checkins.js';
import { findByAnswerTs, getStandup, saveAnswer } from '../db/standups.js';
import type { UserRow } from '../db/types.js';
import { formatKorean } from '../util/time.js';
import { log } from '../util/logger.js';
import { blocks, context, section } from '../slack/blocks/common.js';
import { saveCheckinTasks } from './checkinFlow.js';
import { buildBoardBlocks, syncNextDayTasks } from './standupFlow.js';

const FIELD_LABEL = {
  done_text: 'DONE (오늘 한 일)',
  next_text: 'NEXT (다음에 할 일)',
  note_to_self: '나에게 한 말',
  blocker_text: '막힌 것',
} as const;

/**
 * 사용자가 **이미 보낸 답변 메시지를 편집했을 때** 저장된 값도 따라가게 한다.
 *
 * 슬랙에서 메시지 수정은 `message_changed` 라는 별도 이벤트로 온다.
 * 예전에는 subtype 이 붙은 이벤트를 전부 무시해서, Q3 를 답하기 전에 NEXT 를 고쳐도
 * 처음 쓴 내용이 그대로 올라갔다.
 *
 * 어느 질문의 답이었는지는 저장해 둔 메시지 ts 로 되찾는다.
 * 이미 보드 채널에 요약이 올라갔다면 그 메시지도 같이 고친다.
 *
 * @returns 무언가 갱신했으면 true
 */
export async function applyMessageEdit(
  client: WebClient,
  user: UserRow,
  messageTs: string,
  newText: string,
  channel: string,
): Promise<boolean> {
  const text = newText.trim();
  if (text.length === 0) return false;

  const hit = findByAnswerTs(user.slack_user_id, messageTs);
  if (hit) {
    const { row, field } = hit;
    saveAnswer(user.slack_user_id, row.workday, field, text, messageTs);

    // NEXT 가 바뀌면 그걸로 만든 다음날 할 일도 다시 만들어야 한다.
    if (field === 'next_text') syncNextDayTasks(user, row.workday, text);

    const updated = getStandup(user.slack_user_id, row.workday)!;
    const boardFixed = await updateBoardPost(client, user, updated);

    await client.chat.postMessage({
      channel,
      blocks: blocks(
        section(`:pencil2: *${FIELD_LABEL[field]}* 를 수정한 내용으로 반영했습니다.`),
        context(
          `${formatKorean(row.workday)}` +
            (field === 'next_text' ? ' · 다음 근무일 할 일도 다시 만들었습니다.' : '') +
            (boardFixed ? ' · 채널 요약도 고쳤습니다.' : ''),
        ),
      ),
      text: '수정한 내용을 반영했습니다.',
    });
    return true;
  }

  const checkin = findCheckinByAnswerTs(user.slack_user_id, messageTs);
  if (checkin) {
    saveCheckinTasks(user, checkin.workday, text);
    await client.chat.postMessage({
      channel,
      blocks: blocks(
        section(':pencil2: 수정한 내용으로 오늘 할 일을 다시 등록했습니다.'),
        context(`${formatKorean(checkin.workday)} · \`/plan\` 으로 확인하세요.`),
      ),
      text: '수정한 내용을 반영했습니다.',
    });
    return true;
  }

  return false;
}

/** 이미 채널에 올라간 요약을 새 내용으로 다시 그린다 */
async function updateBoardPost(
  client: WebClient,
  user: UserRow,
  standup: ReturnType<typeof getStandup>,
): Promise<boolean> {
  if (!standup?.board_channel || !standup.board_ts) return false;
  try {
    await client.chat.update({
      channel: standup.board_channel,
      ts: standup.board_ts,
      blocks: buildBoardBlocks(user, standup.workday, standup),
      text: `${user.display_name || '동료'} 의 ${formatKorean(standup.workday)} 마무리`,
    });
    return true;
  } catch (err) {
    log.warn('보드 요약 수정 실패', err);
    return false;
  }
}
