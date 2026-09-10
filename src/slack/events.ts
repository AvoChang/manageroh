import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { openCheckinSession } from '../db/checkins.js';
import { openMiddaySession } from '../db/middays.js';
import { openSession } from '../db/standups.js';
import { beginCheckin, handleCheckinAnswer } from '../service/checkinFlow.js';
import { applyMessageEdit } from '../service/edits.js';
import { beginMidday, handleMiddayAnswer } from '../service/middayFlow.js';
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
  /** subtype 이 message_changed 일 때만 채워진다 */
  message?: { ts: string; text?: string; user?: string; bot_id?: string };
  previous_message?: { text?: string };
}

const CLOCK_IN_WORDS = /^(출근|출근합니다|출근이요|in)$/i;
const CLOCK_OUT_WORDS = /^(퇴근|퇴근합니다|퇴근이요|out)$/i;
const HELP_WORDS = /^(도움말|help|\?)$/i;
const STANDUP_WORDS = /^(마무리|done-next|donenext|보고)$/i;
const CHECKIN_WORDS = /^(할일|할 일|체크인|checkin)$/i;
const MIDDAY_WORDS = /^(중간보고|중간 보고|현황|progress)$/i;

export function registerEvents(app: App): void {
  // ── DM 메시지 = done-next 대화의 답변 ───────────────────────────
  app.message(async ({ message, client }) => {
    const m = message as unknown as IncomingMessage;

    // 메시지 수정은 별도 이벤트로 온다. 저장된 답도 따라가야 한다.
    if (m.subtype === 'message_changed') {
      await handleEdit(client, m);
      return;
    }

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
    // 체크인(아침)·중간 점검(오후)·done-next(저녁)가 겹치면 **나중에 시작된 쪽**이 이긴다.
    const standup = openSession(user.slack_user_id);
    const checkin = openCheckinSession(user.slack_user_id);
    const midday = openMiddaySession(user.slack_user_id);
    const latest = [
      standup && { at: standup.started_at, run: () => handleStandupAnswer(client, user, standup, text, m.ts) },
      midday && { at: midday.started_at, run: () => handleMiddayAnswer(client, user, midday, text, m.ts) },
      checkin && { at: checkin.started_at, run: () => handleCheckinAnswer(client, user, checkin, text, m.ts) },
    ]
      .filter((c): c is { at: string; run: () => Promise<void> } => Boolean(c))
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

    if (latest) {
      await latest.run();
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
    if (MIDDAY_WORDS.test(text)) {
      await beginMidday(client, user, todayFor(user), m.channel);
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

  /**
   * 편집된 메시지 처리.
   *
   * 링크 미리보기가 붙어도 message_changed 가 오므로, 본문이 실제로 바뀐 경우만 다룬다.
   */
  async function handleEdit(client: WebClient, m: IncomingMessage): Promise<void> {
    const edited = m.message;
    if (!edited?.user || !edited.text || edited.bot_id) return;
    if (edited.user === getBotUserId()) return;
    if (m.channel_type !== 'im') return;
    if (m.previous_message?.text === edited.text) return; // 본문은 그대로 (미리보기 등)

    const user = await resolveUser(client, edited.user);
    const applied = await applyMessageEdit(client, user, edited.ts, edited.text, m.channel);
    if (applied) await publishHome(client, user);
  }

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
