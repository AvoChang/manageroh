import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import type { UserRow } from '../db/types.js';
import { updateUser } from '../db/users.js';
import { log } from '../util/logger.js';

/** 사용자와의 DM 채널 id. 한 번 알아내면 users 에 캐시한다. */
export async function dmChannel(client: WebClient, user: UserRow): Promise<string | null> {
  if (user.dm_channel_id) return user.dm_channel_id;
  try {
    const res = await client.conversations.open({ users: user.slack_user_id });
    const id = res.channel?.id ?? null;
    if (id) updateUser(user.slack_user_id, { dm_channel_id: id });
    return id;
  } catch (err) {
    log.warn(`DM 채널을 열지 못했습니다: ${user.slack_user_id}`, err);
    return null;
  }
}

export async function postDm(
  client: WebClient,
  user: UserRow,
  blocks: KnownBlock[],
  text: string,
): Promise<string | null> {
  const channel = await dmChannel(client, user);
  if (!channel) return null;
  const res = await client.chat.postMessage({ channel, blocks, text });
  return res.ts ?? null;
}

export async function postText(
  client: WebClient,
  channel: string,
  text: string,
): Promise<void> {
  await client.chat.postMessage({ channel, text });
}

/**
 * 공개 보드 채널에 올리고 **올린 위치를 돌려준다.**
 * 답변이 나중에 수정되면 그 메시지를 찾아 고쳐야 하므로 ts 가 필요하다.
 * 봇이 채널에 없으면 조용히 넘어간다.
 */
export async function postToBoard(
  client: WebClient,
  user: UserRow,
  blocks: KnownBlock[],
  text: string,
): Promise<{ channel: string; ts: string } | null> {
  if (!user.board_channel_id || !user.share_to_board) return null;
  try {
    const res = await client.chat.postMessage({ channel: user.board_channel_id, blocks, text });
    return res.ts ? { channel: user.board_channel_id, ts: res.ts } : null;
  } catch (err) {
    log.warn(`보드 채널 게시 실패 (${user.board_channel_id})`, err);
    return null;
  }
}

/** 슬랙 프로필에서 표시 이름을 가져온다 */
export async function fetchProfile(
  client: WebClient,
  userId: string,
): Promise<{ name: string; tz: string | null; isBot: boolean }> {
  const res = await client.users.info({ user: userId });
  const u = res.user;
  const name =
    u?.profile?.display_name?.trim() ||
    u?.profile?.real_name?.trim() ||
    u?.real_name?.trim() ||
    u?.name ||
    '';
  return { name, tz: u?.tz ?? null, isBot: Boolean(u?.is_bot) };
}
