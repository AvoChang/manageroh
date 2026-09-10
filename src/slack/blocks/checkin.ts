import type { KnownBlock } from '@slack/types';
import type { MilestoneRow, TaskRow } from '../../db/types.js';
import { formatKorean, type Ymd } from '../../util/time.js';
import { ACTION } from '../ids.js';
import { context, escapeMrkdwn, section, truncate } from './common.js';

/** 권장 개수. 강제하지는 않는다 — 더 적어도, 더 많아도 받는다. */
export const SUGGESTED_TASKS = 3;

/**
 * 오늘 할 일을 묻는 메시지.
 *
 * 예전에는 입력칸 3개짜리 모달이었다. 모달은 제출하면 사라져서 **대화에 기록이 안 남고**,
 * 내가 뭘 적었는지 나중에 다시 볼 방법이 없다. done-next 와 같은 이유로 대화로 바꿨다.
 */
export function checkinPrompt(opts: {
  workday: Ymd;
  carryOver: TaskRow[];
  milestones: MilestoneRow[];
}): KnownBlock[] {
  const body: KnownBlock[] = [
    section(
      `*${formatKorean(opts.workday)}* 오늘 할 일을 알려 주세요.\n` +
        `한 줄에 하나씩, ${SUGGESTED_TASKS}개 정도면 충분합니다. 다 못 채워도 괜찮습니다.`,
    ),
  ];

  if (opts.carryOver.length > 0) {
    body.push(
      section(
        `*아직 안 끝난 할 일* — 이어서 하실 것은 그대로 적어 주세요.\n${opts.carryOver
          .slice(0, 5)
          .map((t) => `• ${escapeMrkdwn(t.title)}`)
          .join('\n')}`,
      ),
    );
  }

  if (opts.milestones.length > 0) {
    body.push(
      context(
        `🎯 마일스톤에 연결하려면 줄 끝에 \`#번호\` 를 붙이세요 — ${opts.milestones
          .slice(0, 5)
          .map((m) => `\`#${m.id}\` ${truncate(m.title, 20)}`)
          .join(' · ')}`,
      ),
    );
  }

  return body;
}

/** 저장한 뒤 그대로 되읽어 준다 — 무엇이 기록됐는지 대화에 남는다 */
export function checkinConfirm(opts: {
  workday: Ymd;
  tasks: TaskRow[];
  milestoneNames: Map<number, string>;
}): KnownBlock[] {
  if (opts.tasks.length === 0) {
    return [
      section(
        `*${formatKorean(opts.workday)}* 할 일을 비웠습니다.\n생각나면 \`/checkin\` 으로 다시 알려 주세요.`,
      ),
    ];
  }

  const lines = opts.tasks.map((t, i) => {
    const ms = t.milestone_id ? opts.milestoneNames.get(t.milestone_id) : undefined;
    return `${i + 1}. ${escapeMrkdwn(t.title)}${ms ? `  🎯 ${escapeMrkdwn(truncate(ms, 24))}` : ''}`;
  });

  return [
    section(`*${formatKorean(opts.workday)}* 할 일 ${opts.tasks.length}개를 등록했습니다.\n${lines.join('\n')}`),
    context('다시 적으면 오늘 목록이 이걸로 바뀝니다. 완료 처리는 `/plan` 이나 홈 탭에서.'),
  ];
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
