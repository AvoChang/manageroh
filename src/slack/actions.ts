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
import { planView } from '../service/plan.js';
import { beginCheckin } from '../service/checkinFlow.js';
import { beginStandup } from '../service/standupFlow.js';
import { addDays, formatKorean } from '../util/time.js';
import { log } from '../util/logger.js';
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

/**
 * 액션 결과를 **새 메시지로** 남긴다.
 *
 * 예전에는 `response_url` 로 답했는데, 슬랙은 그 응답으로 **원본 메시지를 교체**한다.
 * 아침 리마인드에서 "출근" 을 누르면 그 리마인드가 통째로 사라졌다.
 * 기록은 지워지는 게 아니라 쌓여야 한다 — 그래서 항상 DM 에 새 메시지를 붙인다.
 */
async function reply(
  client: WebClient,
  user: UserRow,
  _body: ActionBody,
  text: string,
  blockList?: KnownBlock[],
): Promise<void> {
  await postDm(client, user, blockList ?? blocks(section(text)), text);
}

/**
 * 액션이 시작된 **그 메시지를 다시 그린다.**
 *
 * `reply()` 가 새 메시지를 붙이는 것과는 다른 일이다.
 * 체크박스를 눌렀는데 누른 자리의 ⬜️ 가 그대로면 눌린 건지 알 수 없다.
 * 같은 내용을 최신 상태로 다시 그리는 것은 기록을 지우는 게 아니라 갱신이다.
 * (임시 메시지의 response_url 은 30분 뒤 만료되므로 실패는 조용히 넘긴다.)
 */
async function refreshMessage(body: ActionBody, blockList: KnownBlock[], text: string): Promise<void> {
  if (!body.response_url) return;
  try {
    await fetch(body.response_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        replace_original: true,
        text,
        blocks: blockList,
      }),
    });
  } catch (err) {
    log.debug('메시지 갱신 실패 (만료됐을 수 있음)', err);
  }
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

  // ── 오늘 할 일 (모달 아님 — DM 대화) ────────────────────────────
  app.action(ACTION.openCheckin, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as ActionBody;
    const user = await resolveUser(client, b.user.id, b.team?.id);
    await beginCheckin(client, user, todayFor(user));
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

    // 완료·취소는 목록에서 상태가 바뀌는 게 그대로 보이므로 따로 알리지 않는다.
    // 미루기·삭제는 목록에서 사라져 버리니 어디로 갔는지 한 줄 남긴다.
    let note: string | null = null;
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
        note = `➡️ 내일로 미룸 — ${task.title}`;
        break;
      case 'drop':
        deleteTask(id);
        note = `🗑 삭제 — ${task.title}`;
        break;
      default:
        return;
    }

    const today = todayFor(user);
    await refreshMessage(b, planView(user, today), '오늘 계획');
    if (note) await reply(client, user, b, note);
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
        await reply(client, user, b, `↩︎ *${milestone.title}* 를 다시 진행 중으로 되돌렸습니다.`);
        break;
      case 'archive':
        updateMilestone(id, { status: 'archived' });
        await reply(client, user, b, `📦 *${milestone.title}* 를 보관했습니다.`);
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
        ...codeBlocks(buildReport(user, range, today)),
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
