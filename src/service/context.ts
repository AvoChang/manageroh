import type { WebClient } from '@slack/web-api';
import type { UserRow } from '../db/types.js';
import { ensureUser, getUser, updateUser } from '../db/users.js';
import { fetchProfile } from '../slack/notify.js';
import { nowInTz, type Ymd } from '../util/time.js';
import { log } from '../util/logger.js';

/**
 * 슬랙에서 들어온 사용자 id 를 우리 쪽 사용자 행으로 바꾼다.
 * 처음 보는 사람이면 슬랙 프로필(이름·타임존)을 한 번만 읽어서 채운다.
 */
export async function resolveUser(
  client: WebClient,
  userId: string,
  teamId?: string | null,
): Promise<UserRow> {
  const existing = getUser(userId);
  if (existing && existing.display_name) return existing;

  let name = existing?.display_name ?? '';
  let tz: string | null = existing?.tz ?? null;
  try {
    const profile = await fetchProfile(client, userId);
    name = profile.name || name;
    tz = profile.tz ?? tz;
  } catch (err) {
    log.warn(`프로필 조회 실패: ${userId}`, err);
  }

  return ensureUser({ userId, teamId, displayName: name, tz });
}

export function todayFor(user: UserRow, at: Date = new Date()): Ymd {
  return nowInTz(user.tz, at).date;
}

/** 보드 채널을 아직 모르면 지금 대화 중인 채널을 후보로 기억해 둔다 */
export function rememberBoardChannel(user: UserRow, channelId: string, channelType?: string): void {
  if (user.board_channel_id) return;
  if (channelType === 'im' || channelType === 'mpim') return;
  if (!channelId.startsWith('C') && !channelId.startsWith('G')) return;
  updateUser(user.slack_user_id, { board_channel_id: channelId });
}
