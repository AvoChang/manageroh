import { config, parseWorkDays } from '../config.js';
import { db, nowIso } from './index.js';
import type { UserRow } from './types.js';

export function getUser(userId: string): UserRow | undefined {
  return db().prepare<[string], UserRow>('SELECT * FROM users WHERE slack_user_id = ?').get(userId);
}

/** 없으면 기본 설정으로 만든다. 이미 있으면 그대로 돌려준다. */
export function ensureUser(input: {
  userId: string;
  teamId?: string | null;
  displayName?: string;
  tz?: string | null;
}): UserRow {
  const existing = getUser(input.userId);
  if (existing) {
    // 슬랙 프로필이 바뀌었으면 따라간다.
    const nextName = input.displayName ?? existing.display_name;
    const nextTz = input.tz ?? existing.tz;
    if (nextName !== existing.display_name || nextTz !== existing.tz) {
      db()
        .prepare('UPDATE users SET display_name = ?, tz = ?, updated_at = ? WHERE slack_user_id = ?')
        .run(nextName, nextTz, nowIso(), input.userId);
      return getUser(input.userId)!;
    }
    return existing;
  }

  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO users (
        slack_user_id, slack_team_id, display_name, tz, work_days,
        checkin_time, standup_time, midday_time, nudge_time, weekly_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.teamId ?? null,
      input.displayName ?? '',
      input.tz || config.defaults.tz,
      config.defaults.workDays,
      config.defaults.checkinTime,
      config.defaults.standupTime,
      config.defaults.middayTime,
      config.defaults.nudgeTime,
      config.defaults.weeklyTime,
      ts,
      ts,
    );
  return getUser(input.userId)!;
}

type Patch = Partial<
  Pick<
    UserRow,
    | 'display_name'
    | 'tz'
    | 'work_days'
    | 'checkin_time'
    | 'standup_time'
    | 'midday_time'
    | 'midday_reminder'
    | 'nudge_time'
    | 'weekly_time'
    | 'dm_channel_id'
    | 'board_channel_id'
    | 'share_to_board'
    | 'paused_until'
    | 'active'
  >
>;

export function updateUser(userId: string, patch: Patch): void {
  const keys = Object.keys(patch) as (keyof Patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const params: unknown[] = [...keys.map((k) => patch[k] ?? null), nowIso(), userId];
  db().prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE slack_user_id = ?`).run(...params);
}

export function listActiveUsers(): UserRow[] {
  return db().prepare<[], UserRow>('SELECT * FROM users WHERE active = 1').all();
}

export function listBoardUsers(channelId: string): UserRow[] {
  return db()
    .prepare<[string], UserRow>('SELECT * FROM users WHERE active = 1 AND board_channel_id = ?')
    .all(channelId);
}

export function workDaysOf(user: UserRow): number[] {
  return parseWorkDays(user.work_days);
}

/** 오늘이 일시정지 기간 안인가 */
export function isPaused(user: UserRow, today: string): boolean {
  return user.paused_until !== null && user.paused_until >= today;
}

/** 활성 사용자들이 쓰는 공개 보드 채널 목록 (중복 제거) */
export function listBoardChannels(): string[] {
  return db()
    .prepare<[], { board_channel_id: string }>(
      `SELECT DISTINCT board_channel_id FROM users
       WHERE active = 1 AND board_channel_id IS NOT NULL`,
    )
    .all()
    .map((r) => r.board_channel_id);
}

/**
 * BOARD_CHANNEL_ID 로 지정한 채널을 기본 보드로 깔아 준다.
 * 이미 채널을 고른 사용자는 건드리지 않는다 — /settings 선택을 재시작이 덮어쓰면 안 된다.
 */
export function applyDefaultBoardChannel(channelId: string): number {
  const result = db()
    .prepare('UPDATE users SET board_channel_id = ? WHERE board_channel_id IS NULL')
    .run(channelId);
  return result.changes;
}
