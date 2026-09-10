import type { WebClient } from '@slack/web-api';
import { applyDefaultBoardChannel, ensureUser, getUser, updateUser } from '../db/users.js';
import { config } from '../config.js';
import { fetchProfile } from '../slack/notify.js';
import { log } from '../util/logger.js';

let botUserId: string | null = null;

export function setBotUserId(id: string): void {
  botUserId = id;
}

export function getBotUserId(): string | null {
  return botUserId;
}

/**
 * 봇이 들어가 있는 채널의 사람들을 참여자로 등록한다.
 *
 * "앱이 import 된 채널에서 쓴다" 는 것이 이 앱의 전제이므로,
 * 채널 멤버십이 곧 참여자 명단이다. 명단을 따로 관리하지 않는다.
 */
export async function syncChannelMembers(client: WebClient, channelId: string): Promise<number> {
  let registered = 0;
  let cursor: string | undefined;

  do {
    const res = await client.conversations.members({
      channel: channelId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const memberId of res.members ?? []) {
      if (memberId === botUserId) continue;
      const board = config.board.channelId.trim() || channelId;
      if (await registerMember(client, memberId, board)) registered++;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  log.info(`채널 ${channelId} 멤버 동기화: ${registered}명 신규`);
  return registered;
}

export async function registerMember(
  client: WebClient,
  userId: string,
  boardChannelId: string | null,
): Promise<boolean> {
  const existing = getUser(userId);
  if (existing) {
    if (boardChannelId && !existing.board_channel_id) {
      updateUser(userId, { board_channel_id: boardChannelId });
    }
    return false;
  }

  try {
    const profile = await fetchProfile(client, userId);
    if (profile.isBot) return false;
    ensureUser({ userId, displayName: profile.name, tz: profile.tz });
    if (boardChannelId) updateUser(userId, { board_channel_id: boardChannelId });
    return true;
  } catch (err) {
    log.warn(`멤버 등록 실패: ${userId}`, err);
    return false;
  }
}

/**
 * 참여자 명단을 채널 멤버십에서 가져온다 (부팅 시 1회).
 *
 * BOARD_CHANNEL_ID 가 지정돼 있으면 그 채널만 본다. 지정이 없으면 봇이 들어가 있는
 * 채널을 전부 훑는데, 채널이 둘 이상이면 누가 어느 보드에 묶일지 단정할 수 없다.
 */
export async function syncAllChannels(client: WebClient): Promise<void> {
  const configured = config.board.channelId.trim();

  if (configured) {
    try {
      await syncChannelMembers(client, configured);
    } catch (err) {
      log.error(
        `BOARD_CHANNEL_ID(${configured}) 채널을 읽지 못했습니다. 봇이 그 채널에 초대돼 있는지 확인하세요.`,
        err,
      );
    }
    const filled = applyDefaultBoardChannel(configured);
    if (filled > 0) log.info(`보드 채널을 ${configured} 로 지정한 사용자 ${filled}명`);
    return;
  }

  try {
    const res = await client.users.conversations({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    });
    const channels = (res.channels ?? []).filter((c) => c.id);
    if (channels.length > 1) {
      log.warn(
        `봇이 채널 ${channels.length}개에 들어가 있습니다. BOARD_CHANNEL_ID 를 지정해 어디에 요약을 올릴지 못 박으세요.`,
      );
    }
    for (const channel of channels) {
      await syncChannelMembers(client, channel.id!);
    }
  } catch (err) {
    log.warn('채널 목록 동기화 실패 — 권한(channels:read)을 확인하세요.', err);
  }
}
