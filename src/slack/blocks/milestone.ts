import type { KnownBlock, ModalView } from '@slack/types';
import type { MilestoneRow } from '../../db/types.js';
import { deadlineLabel, progressBar, progressOf } from '../../domain/milestone.js';
import type { Ymd } from '../../util/time.js';
import { ACTION, BLOCK, VIEW } from '../ids.js';
import { actions, blocks, button, context, escapeMrkdwn, section, truncate } from './common.js';

export interface MilestoneMeta {
  milestoneId?: number;
  responseChannel?: string;
}

export function milestoneModal(opts: {
  existing?: MilestoneRow | undefined;
  responseChannel?: string;
}): ModalView {
  const m = opts.existing;
  const meta: MilestoneMeta = { milestoneId: m?.id, responseChannel: opts.responseChannel };

  const body: KnownBlock[] = [
    {
      type: 'input',
      block_id: BLOCK.msTitle,
      label: { type: 'plain_text', text: '마일스톤 이름', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: BLOCK.msTitleAction,
        max_length: 120,
        ...(m ? { initial_value: m.title } : {}),
        placeholder: { type: 'plain_text', text: '예: 포트폴리오 사이트 공개' },
      },
    },
    {
      type: 'input',
      block_id: BLOCK.msDate,
      optional: true,
      label: { type: 'plain_text', text: '목표일', emoji: true },
      element: {
        type: 'datepicker',
        action_id: BLOCK.msDateAction,
        ...(m?.target_date ? { initial_date: m.target_date } : {}),
        placeholder: { type: 'plain_text', text: '날짜 선택' },
      },
    },
    {
      type: 'input',
      block_id: BLOCK.msDesc,
      optional: true,
      label: { type: 'plain_text', text: '무엇이 끝나면 완료인가요?', emoji: true },
      hint: { type: 'plain_text', text: '완료 조건을 적어 두면 나중에 판단이 쉬워집니다.' },
      element: {
        type: 'plain_text_input',
        action_id: BLOCK.msDescAction,
        multiline: true,
        max_length: 1000,
        ...(m?.description ? { initial_value: m.description } : {}),
      },
    },
  ];

  if (m) {
    body.push({
      type: 'input',
      block_id: BLOCK.msProgress,
      optional: true,
      label: { type: 'plain_text', text: '진행도 직접 입력 (%)', emoji: true },
      hint: {
        type: 'plain_text',
        text: '비워 두면 연결된 할 일의 완료 비율로 자동 계산합니다.',
      },
      element: {
        type: 'plain_text_input',
        action_id: BLOCK.msProgressAction,
        max_length: 3,
        ...(m.progress_mode === 'manual' ? { initial_value: String(m.manual_progress) } : {}),
        placeholder: { type: 'plain_text', text: '0 ~ 100' },
      },
    });
  }

  return {
    type: 'modal',
    callback_id: m ? VIEW.milestoneEdit : VIEW.milestone,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: m ? '마일스톤 수정' : '새 마일스톤', emoji: true },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: body,
  };
}

export function milestoneList(milestones: MilestoneRow[], today: Ymd): KnownBlock[] {
  if (milestones.length === 0) {
    return blocks(
      section('*마일스톤이 없습니다.*\n한 달~석 달 뒤에 "끝났다"고 말할 수 있는 것을 하나 정해 보세요.'),
      actions([button({ text: '마일스톤 만들기', actionId: ACTION.openMilestone, style: 'primary' })]),
    );
  }

  const rows: KnownBlock[] = [];
  for (const m of milestones) {
    const p = progressOf(m, today);
    const flag = m.status === 'done' ? '✅' : p.behind ? '⚠️' : '🎯';
    const counts = p.mode === 'auto' && p.totalTasks > 0 ? ` · 할 일 ${p.doneTasks}/${p.totalTasks}` : '';
    const manual = p.mode === 'manual' ? ' · 수동' : '';

    rows.push({
      type: 'section',
      block_id: `ms_${m.id}`,
      text: {
        type: 'mrkdwn',
        text: `${flag} *${escapeMrkdwn(truncate(m.title, 100))}*  \`#${m.id}\`\n\`${progressBar(p.percent)}\` *${p.percent}%* · ${deadlineLabel(p)}${counts}${manual}`,
      },
      accessory: {
        type: 'overflow',
        action_id: `${ACTION.milestoneMenu}_${m.id}`,
        options: [
          { text: { type: 'plain_text', text: '✏️ 수정', emoji: true }, value: `edit:${m.id}` },
          {
            text: {
              type: 'plain_text',
              text: m.status === 'done' ? '↩︎ 다시 진행중' : '✅ 완료 처리',
              emoji: true,
            },
            value: `${m.status === 'done' ? 'reopen' : 'complete'}:${m.id}`,
          },
          { text: { type: 'plain_text', text: '📦 보관', emoji: true }, value: `archive:${m.id}` },
        ],
      },
    });
    if (m.description.trim()) rows.push(context(escapeMrkdwn(truncate(m.description.trim(), 300))));
  }

  rows.push(
    actions([button({ text: '＋ 새 마일스톤', actionId: ACTION.openMilestone })]),
  );
  return rows;
}
