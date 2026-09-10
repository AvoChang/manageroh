import { createServer } from 'node:http';
import { config } from './config.js';
import { closeDb, db } from './db/index.js';
import { startScheduler } from './scheduler/index.js';
import { setBotUserId, syncAllChannels } from './service/members.js';
import { registerActions } from './slack/actions.js';
import { createApp } from './slack/app.js';
import { registerCommands } from './slack/commands.js';
import { registerEvents } from './slack/events.js';
import { registerViews } from './slack/views.js';
import { log } from './util/logger.js';

async function main(): Promise<void> {
  db(); // 스키마 준비를 먼저 — 핸들러가 붙기 전에 테이블이 있어야 한다

  const app = createApp();
  registerCommands(app);
  registerActions(app);
  registerViews(app);
  registerEvents(app);

  if (config.slack.mode === 'socket') {
    await app.start();
    log.info('Socket Mode 로 슬랙에 연결했습니다.');
    startHealthServer();
  } else {
    await app.start(config.slack.port);
    log.info(`HTTP 모드로 :${config.slack.port} 에서 대기합니다.`);
  }

  const auth = await app.client.auth.test();
  if (auth.user_id) {
    setBotUserId(auth.user_id);
    log.info(`봇 사용자: ${auth.user} (${auth.user_id}) · 워크스페이스 ${auth.team}`);
  }

  await syncAllChannels(app.client);
  const stopScheduler = startScheduler(app.client);

  const shutdown = async (signal: string) => {
    log.info(`${signal} 수신 — 정리하고 종료합니다.`);
    stopScheduler();
    try {
      await app.stop();
    } catch {
      // 이미 닫혔으면 무시
    }
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Socket Mode 에서는 열어 둘 포트가 없다.
 * Railway 가 웹 서비스로 붙였을 때 헬스체크가 실패하지 않도록 최소한의 응답만 준다.
 */
function startHealthServer(): void {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  server.listen(config.slack.port, () => {
    log.info(`헬스체크 서버 :${config.slack.port}`);
  });
  server.on('error', (err) => log.warn('헬스체크 서버를 열지 못했습니다', err));
}

main().catch((err) => {
  log.error('부팅 실패', err);
  process.exit(1);
});
