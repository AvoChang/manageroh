import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { getMilestone, listMilestones, updateMilestone } from '../db/milestones.js';
import {
  addTask,
  deleteTask,
  getTask,
  openTasksBefore,
  setTaskStatus,
  tasksForDay,
} from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { buildReport, rangeFor, type ReportPeriod } from '../domain/report.js';
import { doClockIn, doClockOut } from '../service/attendanceFlow.js';
import { resolveUser, todayFor } from '../service/context.js';
import { publishHome } from '../service/home.js';
import { beginStandup } from '../service/standupFlow.js';
import { addDays, formatKorean } from '../util/time.js';
import { log } from '../util/logger.js';
import { checkinModal } from './blocks/checkin.js';
import { blocks, codeBlocks, context, section } from './blocks/common.js';
import { settingsModal } from './blocks/home.js';
import { milestoneList, milestoneModal } from './blocks/milestone.js';
import { ACTION } from './ids.js';
import { postDm } from './notify.js';

interface ActionBody {
  user: { id: string };
  team?: { id: string } | null;
  trigger_id?: string;
  response_url?: string;
  actions?: { action_id: string; value?: string; selected_option?: { value: string } }[];
}

/** 메시지에서 온 액션이면 그 자리에 임시 응답, 홈 탭에서 온 것이면 DM 으로 */
async function reply(
  client: WebClient,
  user: UserRow,
  body: ActionBody,
  text: string,
  blockList?: KnownBlock[],
): Promise<void> {
  const url = body.response_url;
  const payload = blockList ?? blocks(section(text));
  if (url) {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text, blocks: payload }),
    });
    return;
  }
  await postDm(client, user, payload, text);
}

function actionValue(body: ActionBody): string {
  const action = body.actions?.[0];
  return action?.selected_option?.value ?? action?.value ?? '';
}

export function registerActions(app: App): void {
  // ── 출근 · 퇴근 버튼 ────────────────────────────────────────────
  app.action(ACTION.clockIn, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await reply(client, user, b, doClockIn(user));
    await publishHome(client, user);
  });

  app.action(ACTION.clockOut, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await reply(client, user, b, doClockOut(user));
    await publishHome(client, user);
  });

  // ── done-next 시작 ──────────────────────────────────────────────
  app.action(ACTION.openStandup, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await beginStandup(client, user, todayFor(user));
  });

  // ── 오늘 할 일 모달 ─────────────────────────────────────────────
  app.action(ACTION.openCheckin, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    if (!b.trigger_id) return;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    const today = todayFor(user);
    await client.views.open({
      trigger_id: b.trigger_id,
      view: checkinModal({
        workday: today,
        existing: tasksForDay(user.slack_user_id, today),
        carryOver: openTasksBefore(user.slack_user_id, today),
        milestones: listMilestones(user.slack_user_id, 'active'),
      }),
    });
  });

  // ── 어제 것 그대로 이어서 ───────────────────────────────────────
  app.action(ACTION.carryOverAll, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    const today = todayFor(user);
    const carry = openTasksBefore(user.slack_user_id, today);
    for (const t of carry.slice(0, 10)) {
      addTask({
        userId: user.slack_user_id,
        workday: today,
        title: t.title,
        milestoneId: t.milestone_id,
        source: 'plan',
      });
      setTaskStatus(t.id, 'carried');
    }
    await reply(client, user, b, `${carry.length}개를 오늘로 옮겼습니다.`);
    await publishHome(client, user);
  });

  // ── 할 일 오버플로 메뉴 ─────────────────────────────────────────
  app.action(new RegExp(`^${ACTION.taskMenu}_\\d+$`), async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    const [op, rawId] = actionValue(b).split(':');
    const id = Number(rawId);
    const task = Number.isInteger(id) ? getTask(id) : undefined;
    if (!task || task.user_id !== user.slack_user_id) return;

    switch (op) {
      case 'done':
        setTaskStatus(id, 'done');
        break;
      case 'undone':
        setTaskStatus(id, 'planned');
        break;
      case 'defer':
        addTask({
          userId: user.slack_user_id,
          workday: addDays(task.workday, 1),
          title: task.title,
          milestoneId: task.milestone_id,
          source: 'plan',
        });
        setTaskStatus(id, 'carried');
        break;
      case 'drop':
        deleteTask(id);
        break;
      default:
        return;
    }
    await publishHome(client, user);
  });

  // ── 마일스톤 ────────────────────────────────────────────────────
  app.action(ACTION.openMilestone, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    if (!b.trigger_id) return;
    await resolveUser(client, b.user.id, b.team?.id);
    await client.views.open({ trigger_id: b.trigger_id, view: milestoneModal({}) });
  });

  app.action(ACTION.openMilestoneList, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await postDm(
      client,
      user,
      milestoneList(listMilestones(user.slack_user_id), todayFor(user)),
      '마일스톤',
    );
  });

  app.action(new RegExp(`^${ACTION.milestoneMenu}_\\d+$`), async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    const [op, rawId] = actionValue(b).split(':');
    const id = Number(rawId);
    const milestone = Number.isInteger(id) ? getMilestone(id) : undefined;
    if (!milestone || milestone.user_id !== user.slack_user_id) return;

    switch (op) {
      case 'edit':
        if (b.trigger_id) {
          await client.views.open({
            trigger_id: b.trigger_id,
            view: milestoneModal({ existing: milestone }),
          });
        }
        return;
      case 'complete':
        updateMilestone(id, { status: 'done', completed_at: new Date().toISOString() });
        await reply(client, user, b, `🎉 *${milestone.title}* 완료!`);
        break;
      case 'reopen':
        updateMilestone(id, { status: 'active', completed_at: null });
        break;
      case 'archive':
        updateMilestone(id, { status: 'archived' });
        break;
      default:
        return;
    }
    await publishHome(client, user);
  });

  // ── 보고서 버튼 ─────────────────────────────────────────────────
  app.action(new RegExp(`^${ACTION.reportPeriod}_(today|week|month)$`), async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    const today = todayFor(user);
    const raw = actionValue(b);
    const period: ReportPeriod = raw === 'week' || raw === 'month' ? raw : 'today';
    const range = rangeFor(period, today);
    await postDm(
      client,
      user,
      blocks(
        section(`*${range.label} 업무보고*`),
        ...codeBlocks(buildReport(user, period, today)),
        context('그대로 복사해서 쓰세요.'),
      ),
      `${range.label} 업무보고`,
    );
  });

  // ── 설정 · 새로고침 ─────────────────────────────────────────────
  app.action(ACTION.openSettings, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    if (!b.trigger_id) return;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await client.views.open({
      trigger_id: b.trigger_id,
      view: settingsModal(user, user.board_channel_id),
    });
  });

  app.action(ACTION.refreshHome, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await publishHome(client, user);
  });

  // 입력 요소가 값만 바꾸는 경우 — 아무것도 안 하지만 ack 는 해야 한다
  app.action(ACTION.noop, async ({ ack }) => {
    await ack();
  });

  // 모달 안의 select 는 제출 때 한 번에 읽으므로 여기서 ack 만 한다
  for (const id of ['act_milestone_select', 'act_set_tz', 'act_set_workdays', 'act_set_board']) {
    app.action(id, async ({ ack }) => {
      await ack();
    });
  }

  log.debug('액션 핸들러 등록 완료');
}

/** 사용자가 볼 수 있는 오늘 날짜 문자열 — 로그·오류 메시지용 */
export function todayLabel(user: UserRow): string {
  return formatKorean(todayFor(user));
}
