import type { KnownBlock } from '@slack/types';
import { listMilestones } from '../db/milestones.js';
import { tasksForDay } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { taskChecklist } from '../slack/blocks/checkin.js';
import { actions, blocks, button, divider, section } from '../slack/blocks/common.js';
import { ACTION } from '../slack/ids.js';
import { formatKorean, type Ymd } from '../util/time.js';

/**
 * 오늘 할 일 목록 화면.
 *
 * `/plan` 과 체크박스 액션이 **같은 함수**를 쓴다.
 * 완료를 눌렀을 때 그 자리에서 ⬜️ 가 ✅ 로 바뀌려면 누른 메시지를 다시 그려야 하는데,
 * 그리는 코드가 둘로 갈라져 있으면 한쪽만 낡는다.
 */
export function planView(user: UserRow, today: Ymd): KnownBlock[] {
  const milestones = new Map(listMilestones(user.slack_user_id).map((m) => [m.id, m.title]));
  const tasks = tasksForDay(user.slack_user_id, today);
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  return blocks(
    section(`*${formatKorean(today)}* · ${doneCount}/${tasks.length} 완료`),
    taskChecklist(tasks, milestones),
    divider(),
    actions([
      button({ text: '할 일 추가·수정', actionId: ACTION.openCheckin, style: 'primary' }),
      button({ text: '오늘 회고 쓰기', actionId: ACTION.openStandup }),
    ]),
  );
}
