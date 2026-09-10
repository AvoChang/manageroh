/**
 * Block Kit 식별자를 한곳에 모은다.
 * 모달의 callback_id 와 핸들러 등록이 어긋나면 "제출했는데 아무 일도 안 남" 으로만
 * 드러나고 오류가 안 뜬다 — 그래서 문자열을 흩뿌리지 않는다.
 */
export const VIEW = {
  milestone: 'view_milestone',
  milestoneEdit: 'view_milestone_edit',
  settings: 'view_settings',
} as const;

export const ACTION = {
  openCheckin: 'act_open_checkin',
  openStandup: 'act_open_standup',
  openMilestone: 'act_open_milestone',
  openMilestoneList: 'act_open_milestone_list',
  openSettings: 'act_open_settings',
  clockIn: 'act_clock_in',
  clockOut: 'act_clock_out',
  taskMenu: 'act_task_menu',
  milestoneMenu: 'act_milestone_menu',
  carryOverAll: 'act_carry_over_all',
  reportPeriod: 'act_report_period',
  refreshHome: 'act_refresh_home',
  noop: 'act_noop',
} as const;

export const BLOCK = {
  msTitle: 'blk_ms_title',
  msTitleAction: 'act_ms_title',
  msDesc: 'blk_ms_desc',
  msDescAction: 'act_ms_desc',
  msDate: 'blk_ms_date',
  msDateAction: 'act_ms_date',
  msProgress: 'blk_ms_progress',
  msProgressAction: 'act_ms_progress',
  setTz: 'blk_set_tz',
  setTzAction: 'act_set_tz',
  setWorkDays: 'blk_set_workdays',
  setWorkDaysAction: 'act_set_workdays',
  setCheckin: 'blk_set_checkin',
  setCheckinAction: 'act_set_checkin',
  setStandup: 'blk_set_standup',
  setStandupAction: 'act_set_standup',
  setMidday: 'blk_set_midday',
  setMiddayAction: 'act_set_midday',
  setMiddayOn: 'blk_set_midday_on',
  setMiddayOnAction: 'act_set_midday_on',
  setBoard: 'blk_set_board',
  setBoardAction: 'act_set_board',
  setShare: 'blk_set_share',
  setShareAction: 'act_set_share',
} as const;
