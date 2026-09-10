import type { KnownBlock, ModalView, PlainTextOption } from '@slack/types';
import type { MilestoneRow, TaskRow } from '../../db/types.js';
import { formatKorean, type Ymd } from '../../util/time.js';
import { ACTION, BLOCK, VIEW } from '../ids.js';
import { context, escapeMrkdwn, section, truncate } from './common.js';

export const TASK_SLOTS = 3;

export interface CheckinMeta {
  workday: Ymd;
  /** 응답을 돌려보낼 채널 (DM 이면 DM 채널 id) */
  responseChannel?: string;
}

export function checkinModal(opts: {
  workday: Ymd;
  existing: TaskRow[];
  carryOver: TaskRow[];
  milestones: MilestoneRow[];
  responseChannel?: string;
}): ModalView {
  const prefill = [...opts.existing.map((t) => t.title)];
  for (const t of opts.carryOver) if (prefill.length < TASK_SLOTS) prefill.push(t.title);

  const body: KnownBlock[] = [
    section(
      `*${formatKorean(opts.workday)}* 의 할 일을 적어 주세요.\n하루에 세 개면 충분합니다. 다 못 채워도 괜찮습니다.`,
    ),
  ];

  if (opts.carryOver.length > 0) {
    body.push(
      context(
        `어제 못 끝낸 것 ${opts.carryOver.length}개를 미리 채워 뒀습니다 — 지울 것은 지우세요.`,
      ),
    );
  }

  for (let i = 0; i < TASK_SLOTS; i++) {
    body.push({
      type: 'input',
      block_id: BLOCK.taskInput(i),
      optional: i > 0,
      label: { type: 'plain_text', text: `할 일 ${i + 1}`, emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: BLOCK.taskAction(i),
        max_length: 200,
        ...(prefill[i] ? { initial_value: truncate(prefill[i]!, 200) } : {}),
        placeholder: {
          type: 'plain_text',
          text: i === 0 ? '예: 이력서 경력 부분 다시 쓰기' : '(비워 두어도 됩니다)',
        },
      },
    });
  }

  if (opts.milestones.length > 0) {
    body.push({
      type: 'input',
      block_id: BLOCK.milestoneSelect,
      optional: true,
      label: { type: 'plain_text', text: '어느 마일스톤을 향한 일인가요?', emoji: true },
      hint: { type: 'plain_text', text: '고르면 마일스톤 진행도에 자동으로 반영됩니다.' },
      element: {
        type: 'static_select',
        action_id: BLOCK.milestoneSelectAction,
        placeholder: { type: 'plain_text', text: '선택 안 함' },
        options: milestoneOptions(opts.milestones),
      },
    });
  }

  const meta: CheckinMeta = { workday: opts.workday, responseChannel: opts.responseChannel };

  return {
    type: 'modal',
    callback_id: VIEW.checkin,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: '오늘의 출근', emoji: true },
    submit: { type: 'plain_text', text: '시작하기' },
    close: { type: 'plain_text', text: '나중에' },
    blocks: body,
  };
}

export function milestoneOptions(milestones: MilestoneRow[]): PlainTextOption[] {
  return milestones.slice(0, 100).map((m) => ({
    text: { type: 'plain_text' as const, text: truncate(m.title, 75), emoji: true },
    value: String(m.id),
  }));
}

/** 오늘의 할 일 체크리스트 (홈 탭 · /plan 공용) */
export function taskChecklist(tasks: TaskRow[], milestones: Map<number, string>): KnownBlock[] {
  if (tasks.length === 0) {
    return [context('오늘 등록된 할 일이 없습니다. `/checkin` 으로 시작하세요.')];
  }
  return tasks.map((t) => {
    const isDone = t.status === 'done';
    const mark = isDone ? '~' : '';
    const ms = t.milestone_id ? milestones.get(t.milestone_id) : undefined;
    const suffix = ms ? `  \`${truncate(ms, 24)}\`` : '';
    return {
      type: 'section',
      block_id: `task_${t.id}`,
      text: {
        type: 'mrkdwn',
        text: `${isDone ? '✅' : '⬜️'} ${mark}${escapeMrkdwn(t.title)}${mark}${suffix}`,
      },
      accessory: {
        type: 'overflow',
        action_id: `${ACTION.taskMenu}_${t.id}`,
        options: [
          {
            text: { type: 'plain_text', text: isDone ? '↩︎ 완료 취소' : '✅ 완료 처리', emoji: true },
            value: `${isDone ? 'undone' : 'done'}:${t.id}`,
          },
          {
            text: { type: 'plain_text', text: '➡️ 내일로 미루기', emoji: true },
            value: `defer:${t.id}`,
          },
          { text: { type: 'plain_text', text: '🗑 삭제', emoji: true }, value: `drop:${t.id}` },
        ],
      },
    } satisfies KnownBlock;
  });
}
