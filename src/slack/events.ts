import type { App } from '@slack/bolt';
import { openCheckinSession } from '../db/checkins.js';
import { openSession } from '../db/standups.js';
import { beginCheckin, handleCheckinAnswer } from '../service/checkinFlow.js';
import { doClockIn, doClockOut } from '../service/attendanceFlow.js';
import { rememberBoardChannel, resolveUser, todayFor } from '../service/context.js';
import { publishHome } from '../service/home.js';
import { getBotUserId, registerMember, syncChannelMembers } from '../service/members.js';
import { beginStandup, handleStandupAnswer, isSubmitted } from '../service/standupFlow.js';
import { log } from '../util/logger.js';
import { actions, blocks, button, context, section } from './blocks/common.js';
import { COPY } from './copy.js';
import { ACTION } from './ids.js';

interface IncomingMessage {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

const CLOCK_IN_WORDS = /^(출근|출근합니다|출근이요|in)$/i;
const CLOCK_OUT_WORDS = /^(퇴근|퇴근합니다|퇴근이요|out)$/i;
const HELP_WORDS = /^(도움말|help|\?)$/i;
const STANDUP_WORDS = /^(마무리|done-next|donenext|보고)$/i;
const CHECKIN_WORDS = /^(할일|할 일|체크인|checkin)$/i;

export function registerEvents(app: App): void {
  // ── DM 메시지 = done-next 대화의 답변 ───────────────────────────
  app.message(async ({ message, client }) => {
    const m = message as unknown as IncomingMessage;
    if (m.bot_id || m.subtype !== undefined) return;
    if (!m.user || !m.text) return;
    if (m.user === getBotUserId()) return;
    if (m.channel_type !== 'im') return; // 답변은 DM 에서만 받는다

    const user = await resolveUser(client, m.user);
    const text = m.text.trim();

    if (CLOCK_IN_WORDS.test(text)) {
      await client.chat.postMessage({ channel: m.channel, text: doClockIn(user) });
      await publishHome(client, user);
      return;
    }
    if (CLOCK_OUT_WORDS.test(text)) {
      await client.chat.postMessage({ channel: m.channel, text: doClockOut(user) });
      await publishHome(client, user);
      return;
    }
    if (HELP_WORDS.test(text)) {
      await client.chat.postMessage({ channel: m.channel, text: COPY.help });
      return;
    }

    // 진행 중인 대화가 있으면 그 답으로 받는다.
    // 체크인(아침)과 done-next(저녁)가 둘 다 열려 있으면 **나중에 시작된 쪽**이 이긴다.
    const standup = openSession(user.slack_user_id);
    const checkin = openCheckinSession(user.slack_user_id);
    const standupWins =
      standup !== undefined && (checkin === undefined || standup.started_at >= checkin.started_at);

    if (standup && standupWins) {
      await handleStandupAnswer(client, user, standup, text);
      await publishHome(client, user);
      return;
    }
    if (checkin) {
      await handleCheckinAnswer(client, user, checkin, text);
      await publishHome(client, user);
      return;
    }

    if (STANDUP_WORDS.test(text)) {
      await beginStandup(client, user, todayFor(user), m.channel);
      return;
    }
    if (CHECKIN_WORDS.test(text)) {
      await beginCheckin(client, user, todayFor(user), m.channel);
      return;
    }

    // 대화 중이 아닌데 말을 걸었다 — 무엇을 할 수 있는지 짧게 보여 준다.
    const today = todayFor(user);
    await client.chat.postMessage({
      channel: m.channel,
      text: '무엇을 도와드릴까요?',
      blocks: blocks(
        section('지금은 질문을 기다리는 중이 아니에요. 아래에서 고르시거나 `도움말` 이라고 적어 주세요.'),
        actions([
          button({
            text: isSubmitted(user.slack_user_id, today) ? '오늘 보고 다시 쓰기' : '오늘 마무리하기',
            actionId: ACTION.openStandup,
            style: 'primary',
          }),
          button({ text: '오늘 할 일 정하기', actionId: ACTION.openCheckin }),
          button({ text: '오늘 보고서', actionId: `${ACTION.reportPeriod}_today`, value: 'today' }),
        ]),
        context('`출근` · `퇴근` · `할일` 이라고 적어도 동작합니다.'),
      ),
    });
  });

  // ── 홈 탭 ───────────────────────────────────────────────────────
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    const user = await resolveUser(client, event.user);
    await publishHome(client, user);
  });

  // ── 채널 참여 ───────────────────────────────────────────────────
  app.event('member_joined_channel', async ({ event, client }) => {
    const botId = getBotUserId();
    if (event.user === botId) {
      // 봇이 초대됐다 — 그 채널 사람들을 참여자로 등록한다.
      await syncChannelMembers(client, event.channel);
      await client.chat.postMessage({
        channel: event.channel,
        text: '업무 리듬 봇이 합류했습니다.',
        blocks: blocks(
          section(
            '*안녕하세요. 오늘부터 이 채널이 여러분의 출근부입니다.*\n' +
              '아침에는 어제 하기로 한 일을 알려 드리고, 저녁에는 오늘 무엇을 했는지 여쭙습니다.',
          ),
          context('먼저 `/settings` 에서 시간과 타임존을 확인해 주세요. `/help` 로 전체 명령을 봅니다.'),
        ),
      });
      return;
    }
    await registerMember(client, event.user, event.channel);
  });

  // ── 멘션 ────────────────────────────────────────────────────────
  app.event('app_mention', async ({ event, client }) => {
    if (!event.user) return;
    const user = await resolveUser(client, event.user);
    rememberBoardChannel(user, event.channel, 'channel');
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: COPY.help,
    });
  });

  log.debug('이벤트 핸들러 등록 완료');
}
