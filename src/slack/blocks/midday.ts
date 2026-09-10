import type { KnownBlock } from '@slack/types';
import type { MilestoneRow, TaskRow } from '../../db/types.js';
import { formatKorean, type Ymd } from '../../util/time.js';
import { COPY } from '../copy.js';
import { taskChecklist } from './checkin.js';
import { blocks, context, escapeMrkdwn, section } from './common.js';

/**
 * 오후 중간 점검.
 *
 * 아침에 하기로 한 것과 `/done` 으로 갱신한 것을 **한 목록으로** 보여 주고,
 * 진행을 적어 달라고 촉구한다. 답이 없어도 문제되지 않는다 —
 * 저녁 회고가 시작되면 세션이 알아서 닫힌다.
 */
export function middayPrompt(opts: {
  workday: Ymd;
  tasks: TaskRow[];
  milestones: MilestoneRow[];
}): KnownBlock[] {
  const names = new Map(opts.milestones.map((m) => [m.id, m.title]));
  const done = opts.tasks.filter((t) => t.status === 'done').length;

  return blocks(
    section(`${COPY.midday.title}\n${COPY.midday.question}`),
    opts.tasks.length === 0
      ? section(COPY.midday.noPlan)
      : section(`*${formatKorean(opts.workday)} 진행 현황* (${done}/${opts.tasks.length})`),
    opts.tasks.length > 0 ? taskChecklist(opts.tasks, names) : null,
    opts.tasks.length > 0 ? context(COPY.midday.prompt) : null,
  );
}

/** 답변을 반영한 뒤 무엇이 바뀌었는지 그대로 되읽어 준다 */
export function middayConfirm(opts: {
  workday: Ymd;
  completed: string[];
  added: string[];
  tasks: TaskRow[];
  milestones: MilestoneRow[];
}): KnownBlock[] {
  const names = new Map(opts.milestones.map((m) => [m.id, m.title]));
  const done = opts.tasks.filter((t) => t.status === 'done').length;

  const changes: string[] = [];
  for (const title of opts.completed) changes.push(`✅ ${escapeMrkdwn(title)}`);
  for (const title of opts.added) changes.push(`➕ ${escapeMrkdwn(title)} _(새로 기록)_`);

  return blocks(
    section(
      changes.length > 0
        ? `*${COPY.midday.applied}*\n${changes.join('\n')}`
        : COPY.midday.nothingMatched,
    ),
    section(`*${formatKorean(opts.workday)} 진행 현황* (${done}/${opts.tasks.length})`),
    taskChecklist(opts.tasks, names),
    context('남은 것은 저녁 회고 때 정리하시면 됩니다.'),
  );
}
