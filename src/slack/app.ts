import { App, LogLevel } from '@slack/bolt';
import { config } from '../config.js';
import { log } from '../util/logger.js';

export function createApp(): App {
  const logLevel = config.logLevel === 'debug' ? LogLevel.DEBUG : LogLevel.WARN;

  const app =
    config.slack.mode === 'socket'
      ? new App({
          token: config.slack.botToken,
          appToken: config.slack.appToken,
          socketMode: true,
          logLevel,
        })
      : new App({
          token: config.slack.botToken,
          signingSecret: config.slack.signingSecret,
          logLevel,
        });

  app.error(async (error) => {
    log.error('처리되지 않은 오류', error);
  });

  return app;
}
