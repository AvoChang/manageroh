/**
 * 실제 슬랙에 홈 탭을 게시해 보고 블록이 통과하는지 확인한다.
 *   npx tsx scripts/verify-home.ts
 *
 * 봇을 띄우지 않고 views.publish 만 호출하므로 남에게 메시지가 가지 않는다.
 */
import { WebClient } from '@slack/web-api';
import { config } from '../src/config.js';
import { listActiveUsers } from '../src/db/users.js';
import { publishHome } from '../src/service/home.js';

const client = new WebClient(config.slack.botToken);
const auth = await client.auth.test();
console.log(`봇: ${auth.user} · 워크스페이스: ${auth.team}`);

const users = listActiveUsers();
if (users.length === 0) {
  console.log('등록된 사용자가 없습니다. 봇을 한 번 띄워 채널 멤버를 동기화하세요.');
  process.exit(0);
}

for (const u of users) {
  try {
    await client.views.publish({
      user_id: u.slack_user_id,
      view: { type: 'home', blocks: [] },
    });
  } catch (err) {
    // 빈 뷰가 거부되는 것은 정상 — 아래 진짜 게시가 판정 기준이다
    void err;
  }

  const before = Date.now();
  await publishHome(client, u);
  console.log(`  ${u.slack_user_id} (${u.display_name || '이름없음'}) — ${Date.now() - before}ms`);
}

console.log('\n위에 "홈 탭 갱신 실패" 가 없으면 통과입니다. 슬랙에서 봇 → 홈 탭을 열어 확인하세요.');
