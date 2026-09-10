export type TaskStatus = 'planned' | 'done' | 'carried' | 'dropped';
export type TaskSource = 'checkin' | 'done' | 'standup' | 'plan';
export type MilestoneStatus = 'active' | 'done' | 'archived';
export type ProgressMode = 'auto' | 'manual';
export type StandupStage = 'q1' | 'q2' | 'q3' | 'complete';

export interface UserRow {
  slack_user_id: string;
  slack_team_id: string | null;
  display_name: string;
  tz: string;
  work_days: string;
  checkin_time: string;
  standup_time: string;
  midday_time: string;
  midday_reminder: number;
  nudge_time: string;
  weekly_time: string;
  dm_channel_id: string | null;
  board_channel_id: string | null;
  share_to_board: number;
  paused_until: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  user_id: string;
  workday: string;
  title: string;
  status: TaskStatus;
  milestone_id: number | null;
  source: TaskSource;
  created_at: string;
  done_at: string | null;
}

export interface StandupRow {
  id: number;
  user_id: string;
  workday: string;
  done_text: string;
  next_text: string;
  note_to_self: string;
  blocker_text: string;
  mood: number | null;
  submitted_at: string | null;
  done_ts: string | null;
  next_ts: string | null;
  note_ts: string | null;
  board_channel: string | null;
  board_ts: string | null;
}

export interface StandupSessionRow {
  user_id: string;
  workday: string;
  stage: StandupStage;
  channel_id: string;
  started_at: string;
  updated_at: string;
}

export interface AttendanceRow {
  user_id: string;
  workday: string;
  clock_in: string | null;
  clock_out: string | null;
  break_minutes: number;
  worked_minutes: number | null;
  auto_closed: number;
}

export interface MilestoneRow {
  id: number;
  user_id: string;
  title: string;
  description: string;
  target_date: string | null;
  status: MilestoneStatus;
  progress_mode: ProgressMode;
  manual_progress: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StreakRow {
  user_id: string;
  current: number;
  longest: number;
  last_workday: string | null;
  total_days: number;
}
