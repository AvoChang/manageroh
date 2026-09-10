import type { App } from '@slack/bolt';
import { createMilestone, getMilestone, updateMilestone } from '../db/milestones.js';
import { getUser, updateUser } from '../db/users.js';
import { resolveUser } from '../service/context.js';
import { publishHome } from '../service/home.js';
import { log } from '../util/logger.js';
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
    const midday = readValue(view, BLOCK.setMidday, BLOCK.setMiddayAction);
    const middayOn = readChecked(view, BLOCK.setMiddayOn, BLOCK.setMiddayOnAction);
    const board = readValue(view, BLOCK.setBoard, BLOCK.setBoardAction);
    const share = readChecked(view, BLOCK.setShare, BLOCK.setShareAction);

    updateUser(user.slack_user_id, {
      ...(tz ? { tz } : {}),
      ...(workDays ? { work_days: workDays } : {}),
      ...(checkin ? { checkin_time: checkin } : {}),
      ...(standup ? { standup_time: standup } : {}),
      ...(midday ? { midday_time: midday } : {}),
      midday_reminder: middayOn ? 1 : 0,
      board_channel_id: board ?? null,
      share_to_board: share ? 1 : 0,
    });

    const updated = getUser(user.slack_user_id)!;
    await publishHome(client, updated);

    // 설정도 "내가 뭘 바꿨더라" 를 되짚을 수 있어야 한다 — 한 줄로 남긴다.
    await postDm(
      client,
      updated,
      blocks(
        section(
          `⚙️ 설정을 저장했습니다.\n` +
            `• 타임존 ${updated.tz} · 근무 요일 ${updated.work_days}\n` +
            `• 아침 ${updated.checkin_time} · 중간 점검 ${updated.midday_reminder ? updated.midday_time : '꺼짐'} · done-next ${updated.standup_time}\n` +
            `• 공개 보드 ${updated.board_channel_id ? `<#${updated.board_channel_id}>` : '없음'}` +
            `${updated.share_to_board ? '' : ' (공유 꺼짐)'}`,
        ),
      ),
      '설정을 저장했습니다.',
    );
    log.debug(`설정 저장: ${user.slack_user_id}`);
  });
}
