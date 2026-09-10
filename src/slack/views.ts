import type { App } from '@slack/bolt';
import { createMilestone, getMilestone, updateMilestone } from '../db/milestones.js';
import { addTask, deleteTask, setTaskMilestone, tasksForDay } from '../db/tasks.js';
import { updateUser } from '../db/users.js';
import { resolveUser, todayFor } from '../service/context.js';
import { publishHome } from '../service/home.js';
import { formatKorean } from '../util/time.js';
import { log } from '../util/logger.js';
import { TASK_SLOTS, type CheckinMeta } from './blocks/checkin.js';
import type { MilestoneMeta } from './blocks/milestone.js';
import { BLOCK, VIEW } from './ids.js';
import { postDm } from './notify.js';
import { blocks, section } from './blocks/common.js';

interface ViewLike {
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, unknown>> };
}

/** 모달 입력 하나를 읽는다. 타입이 제각각이라 한곳에서 흡수한다. */
function readValue(view: ViewLike, block: string, action: string): string | undefined {
  const el = view.state?.values?.[block]?.[action] as
    | {
        value?: string | null;
        selected_option?: { value?: string } | null;
        selected_options?: { value?: string }[] | null;
        selected_date?: string | null;
        selected_time?: string | null;
        selected_conversation?: string | null;
      }
    | undefined;
  if (!el) return undefined;
  if (typeof el.value === 'string') return el.value;
  if (el.selected_option?.value) return el.selected_option.value;
  if (el.selected_date) return el.selected_date;
  if (el.selected_time) return el.selected_time;
  if (el.selected_conversation) return el.selected_conversation;
  return undefined;
}

function readChecked(view: ViewLike, block: string, action: string): boolean {
  const el = view.state?.values?.[block]?.[action] as
    | { selected_options?: { value?: string }[] | null }
    | undefined;
  return (el?.selected_options?.length ?? 0) > 0;
}

function parseMeta<T>(view: ViewLike): Partial<T> {
  if (!view.private_metadata) return {};
  try {
    return JSON.parse(view.private_metadata) as Partial<T>;
  } catch {
    return {};
  }
}

export function registerViews(app: App): void {
  // ── 오늘 할 일 저장 ─────────────────────────────────────────────
  app.view(VIEW.checkin, async ({ ack, body, view, client }) => {
    await ack();
    const user = await resolveUser(client, body.user.id, body.team?.id);
    const meta = parseMeta<CheckinMeta>(view);
    const workday = meta.workday ?? todayFor(user);

    const titles: string[] = [];
    for (let i = 0; i < TASK_SLOTS; i++) {
      const raw = readValue(view, BLOCK.taskInput(i), BLOCK.taskAction(i))?.trim();
      if (raw) titles.push(raw);
    }

    const rawMilestone = readValue(view, BLOCK.milestoneSelect, BLOCK.milestoneSelectAction);
    const milestoneId = rawMilestone ? Number(rawMilestone) : null;

    // 완료한 할 일은 손대지 않는다. 계획 상태인 것만 입력값에 맞춘다.
    const existing = tasksForDay(user.slack_user_id, workday).filter((t) => t.status === 'planned');
    const kept = new Set<string>();

    for (const title of titles) {
      const match = existing.find((t) => t.title === title);
      if (match) {
        kept.add(title);
        if (milestoneId && !match.milestone_id) setTaskMilestone(match.id, milestoneId);
        continue;
      }
      addTask({
        userId: user.slack_user_id,
        workday,
        title,
        milestoneId,
        source: 'checkin',
      });
    }

    for (const t of existing) {
      if (!kept.has(t.title) && !titles.includes(t.title)) deleteTask(t.id);
    }

    await publishHome(client, user);
    await postDm(
      client,
      user,
      blocks(
        section(
          `*${formatKorean(workday)}* 할 일 ${titles.length}개를 등록했습니다.\n${titles
            .map((t, i) => `${i + 1}. ${t}`)
            .join('\n')}`,
        ),
      ),
      '오늘 할 일을 등록했습니다.',
    );
  });

  // ── 마일스톤 생성 ───────────────────────────────────────────────
  app.view(VIEW.milestone, async ({ ack, body, view, client }) => {
    await ack();
    const user = await resolveUser(client, body.user.id, body.team?.id);
    const title = readValue(view, BLOCK.msTitle, BLOCK.msTitleAction)?.trim();
    if (!title) return;

    const milestone = createMilestone({
      userId: user.slack_user_id,
      title,
      description: readValue(view, BLOCK.msDesc, BLOCK.msDescAction) ?? '',
      targetDate: readValue(view, BLOCK.msDate, BLOCK.msDateAction) ?? null,
    });

    await publishHome(client, user);
    await postDm(
      client,
      user,
      blocks(
        section(
          `🎯 마일스톤 *${milestone.title}* 를 만들었습니다. \`#${milestone.id}\`\n할 일을 여기에 연결하면 진행도가 자동으로 올라갑니다.`,
        ),
      ),
      '마일스톤을 만들었습니다.',
    );
  });

  // ── 마일스톤 수정 ───────────────────────────────────────────────
  app.view(VIEW.milestoneEdit, async ({ ack, body, view, client }) => {
    await ack();
    const user = await resolveUser(client, body.user.id, body.team?.id);
    const meta = parseMeta<MilestoneMeta>(view);
    if (!meta.milestoneId) return;

    const milestone = getMilestone(meta.milestoneId);
    if (!milestone || milestone.user_id !== user.slack_user_id) return;

    const title = readValue(view, BLOCK.msTitle, BLOCK.msTitleAction)?.trim();
    const rawProgress = readValue(view, BLOCK.msProgress, BLOCK.msProgressAction)?.trim();
    const parsed = rawProgress ? Number(rawProgress) : NaN;
    const manual = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

    updateMilestone(meta.milestoneId, {
      ...(title ? { title } : {}),
      description: readValue(view, BLOCK.msDesc, BLOCK.msDescAction) ?? '',
      target_date: readValue(view, BLOCK.msDate, BLOCK.msDateAction) ?? null,
      progress_mode: manual ? 'manual' : 'auto',
      manual_progress: manual ? Math.round(parsed) : 0,
    });

    await publishHome(client, user);
  });

  // ── 설정 저장 ───────────────────────────────────────────────────
  app.view(VIEW.settings, async ({ ack, body, view, client }) => {
    await ack();
    const user = await resolveUser(client, body.user.id, body.team?.id);

    const tz = readValue(view, BLOCK.setTz, BLOCK.setTzAction);
    const workDays = readValue(view, BLOCK.setWorkDays, BLOCK.setWorkDaysAction);
    const checkin = readValue(view, BLOCK.setCheckin, BLOCK.setCheckinAction);
    const standup = readValue(view, BLOCK.setStandup, BLOCK.setStandupAction);
    const board = readValue(view, BLOCK.setBoard, BLOCK.setBoardAction);
    const share = readChecked(view, BLOCK.setShare, BLOCK.setShareAction);

    updateUser(user.slack_user_id, {
      ...(tz ? { tz } : {}),
      ...(workDays ? { work_days: workDays } : {}),
      ...(checkin ? { checkin_time: checkin } : {}),
      ...(standup ? { standup_time: standup } : {}),
      board_channel_id: board ?? null,
      share_to_board: share ? 1 : 0,
    });

    const updated = await resolveUser(client, body.user.id, body.team?.id);
    await publishHome(client, updated);
    log.debug(`설정 저장: ${user.slack_user_id}`);
  });
}
