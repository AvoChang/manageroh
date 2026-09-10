/** 봇이 들어가 있는 채널 목록. BOARD_CHANNEL_ID 를 정할 때 쓴다. */
import { WebClient } from '@slack/web-api';
import { config } from '../src/config.js';

const client = new WebClient(config.slack.botToken);
const res = await client.users.conversations({
  types: 'public_channel,private_channel',
  exclude_archived: true,
  limit: 200,
});
for (const ch of res.channels ?? []) {
  console.log(`${ch.id}  #${ch.name}${ch.is_private ? '  (비공개)' : ''}`);
}
