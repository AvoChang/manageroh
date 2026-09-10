import type { KnownBlock, ModalView } from '@slack/types';
import type { AttendanceRow, MilestoneRow, StandupRow, StreakRow, TaskRow, UserRow } from '../../db/types.js';
import { formatDuration, localTime } from '../../domain/attendance.js';
import { deadlineLabel, progressBar, progressOf } from '../../domain/milestone.js';
import { formatKorean, type Ymd } from '../../util/time.js';
import { ACTION, BLOCK, VIEW } from '../ids.js';
import { actions, blocks, button, context, divider, header, section } from './common.js';
import { taskChecklist } from './checkin.js';

export function homeView(opts: {
  user: UserRow;
  today: Ymd;
  tasks: TaskRow[];
  milestones: MilestoneRow[];
  streak: StreakRow;
  badge: string;
  attendance: AttendanceRow | undefined;
  minutesToday: number | null;
  weekMinutes: number;
  standup: StandupRow | undefined;
}): KnownBlock[] {
  const msNames = new Map(opts.milestones.map((m) => [m.id, m.title]));
  const doneCount = opts.tasks.filter((t) => t.status === 'done').length;

  const working = Boolean(opts.attendance?.clock_in && !opts.attendance.clock_out);
  const clockLine = opts.attendance?.clock_in
    ? working
      ? `:office: ${localTime(opts.attendance.clock_in, opts.user.tz)} 출근 · 지금까지 ${formatDuration(opts.minutesToday ?? 0)}`
      : `:door: ${localTime(opts.attendance.clock_in, opts.user.tz)} ~ ${localTime(opts.attendance.clock_out!, opts.user.tz)} · ${formatDuration(opts.attendance.worked_minutes ?? 0)}`
    : '아직 출근 전입니다.';

  return blocks(
    header(`${formatKorean(opts.today)}`),
    section(
      `${opts.badge} *연속 ${opts.streak.current}일* (최장 ${opts.streak.longest}일 · 누적 ${opts.streak.total_days}일)\n${clockLine}\n이번 주 근무 *${formatDuration(opts.weekMinutes)}*`,
    ),
    actions([
      working
        ? button({ text: '퇴근하기', actionId: ACTION.clockOut, style: 'danger' })
        : button({ text: '출근하기', actionId: ACTION.clockIn, style: 'primary' }),
      button({
        text: opts.standup?.submitted_at ? '회고 다시 쓰기' : '오늘 회고 쓰기',
        actionId: ACTION.openStandup,
      }),
      button({ text: '새로고침', actionId: ACTION.refreshHome }),
    ]),
    divider(),

    section(`*오늘 할 일* (${doneCount}/${opts.tasks.length})`),
    taskChecklist(opts.tasks, msNames),
    actions([
      button({ text: '할 일 추가·수정', actionId: ACTION.openCheckin }),
      button({ text: '오늘 보고서', actionId: `${ACTION.reportPeriod}_today`, value: 'today' }),
      button({ text: '주간 보고서', actionId: `${ACTION.reportPeriod}_week`, value: 'week' }),
    ]),
    divider(),

    section('*마일스톤*'),
    milestoneSummary(opts.milestones, opts.today),
    actions([
      button({ text: '마일스톤 관리', actionId: ACTION.openMilestoneList }),
      button({ text: '설정', actionId: ACTION.openSettings }),
    ]),
    context(
      `아침 ${opts.user.checkin_time} 리마인드 · 저녁 ${opts.user.standup_time} done-next · ${opts.user.tz}`,
    ),
  );
}

function milestoneSummary(milestones: MilestoneRow[], today: Ymd): KnownBlock[] {
  const active = milestones.filter((m) => m.status === 'active').slice(0, 5);
  if (active.length === 0) {
    return [context('진행 중인 마일스톤이 없습니다. 한 달 뒤 "끝났다"고 말할 것을 하나 정해 보세요.')];
  }
  return active.map((m) => {
    const p = progressOf(m, today);
    return context(
      `${p.behind ? '⚠️' : '🎯'} *${m.title}*  \`${progressBar(p.percent)}\` ${p.percent}% · ${deadlineLabel(p)}`,
    );
  });
}

const TZ_OPTIONS = [
  'Asia/Seoul',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

const WORKDAY_OPTIONS: { text: string; value: string }[] = [
  { text: '월~금 (주 5일)', value: '1,2,3,4,5' },
  { text: '월~토 (주 6일)', value: '1,2,3,4,5,6' },
  { text: '매일 (주 7일)', value: '1,2,3,4,5,6,7' },
  { text: '월·수·금', value: '1,3,5' },
  { text: '화·목', value: '2,4' },
];

export function settingsModal(user: UserRow, boardChannelId: string | null): ModalView {
  const workdayOption =
    WORKDAY_OPTIONS.find((o) => o.value === user.work_days) ?? WORKDAY_OPTIONS[0]!;
  const shareOption = {
    text: { type: 'plain_text' as const, text: '보고를 공개 채널에도 올리기', emoji: true },
    value: 'share',
  };

  return {
    type: 'modal',
    callback_id: VIEW.settings,
    title: { type: 'plain_text', text: '설정', emoji: true },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK.setTz,
        label: { type: 'plain_text', text: '타임존', emoji: true },
        element: {
          type: 'static_select',
          action_id: BLOCK.setTzAction,
          initial_option: {
            text: { type: 'plain_text', text: user.tz },
            value: user.tz,
          },
          options: [...new Set([user.tz, ...TZ_OPTIONS])].map((tz) => ({
            text: { type: 'plain_text' as const, text: tz },
            value: tz,
          })),
        },
      },
      {
        type: 'input',
        block_id: BLOCK.setWorkDays,
        label: { type: 'plain_text', text: '근무 요일', emoji: true },
        hint: { type: 'plain_text', text: '근무일이 아닌 날은 물어보지 않고, 연속 기록도 안 끊깁니다.' },
        element: {
          type: 'static_select',
          action_id: BLOCK.setWorkDaysAction,
          initial_option: {
            text: { type: 'plain_text', text: workdayOption.text },
            value: workdayOption.value,
          },
          options: WORKDAY_OPTIONS.map((o) => ({
            text: { type: 'plain_text' as const, text: o.text },
            value: o.value,
          })),
        },
      },
      {
        type: 'input',
        block_id: BLOCK.setCheckin,
        label: { type: 'plain_text', text: '아침 리마인드 시각', emoji: true },
        element: {
          type: 'timepicker',
          action_id: BLOCK.setCheckinAction,
          initial_time: user.checkin_time,
        },
      },
      {
        type: 'input',
        block_id: BLOCK.setStandup,
        label: { type: 'plain_text', text: 'done-next 시각', emoji: true },
        element: {
          type: 'timepicker',
          action_id: BLOCK.setStandupAction,
          initial_time: user.standup_time,
        },
      },
      {
        type: 'input',
        block_id: BLOCK.setBoard,
        optional: true,
        label: { type: 'plain_text', text: '공개 보드 채널', emoji: true },
        hint: { type: 'plain_text', text: '봇이 초대된 채널만 고를 수 있습니다.' },
        element: {
          type: 'conversations_select',
          action_id: BLOCK.setBoardAction,
          filter: { include: ['public', 'private'], exclude_bot_users: true },
          ...(boardChannelId ? { initial_conversation: boardChannelId } : {}),
        },
      },
      {
        type: 'input',
        block_id: BLOCK.setShare,
        optional: true,
        label: { type: 'plain_text', text: '공유', emoji: true },
        element: {
          type: 'checkboxes',
          action_id: BLOCK.setShareAction,
          options: [shareOption],
          ...(user.share_to_board ? { initial_options: [shareOption] } : {}),
        },
      },
    ],
  };
}
