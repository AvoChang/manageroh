import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { getMilestone, listMilestones, updateMilestone } from '../db/milestones.js';
import { getStandup } from '../db/standups.js';
import { getStreak } from '../db/streaks.js';
import { addTask, openTasksBefore, tasksForDay } from '../db/tasks.js';
import { updateUser } from '../db/users.js';
import type { UserRow } from '../db/types.js';
import { formatDuration, setManualAttendance, summarize } from '../domain/attendance.js';
import { buildHistory, buildReport, historyLines, parseRange } from '../domain/report.js';
import { streakBadge } from '../domain/streak.js';
import { doClockIn, doClockOut } from '../service/attendanceFlow.js';
import { resolveUser, todayFor } from '../service/context.js';
import { publishHome } from '../service/home.js';
import { planView } from '../service/plan.js';
import { beginCheckin } from '../service/checkinFlow.js';
import { beginMidday } from '../service/middayFlow.js';
import { beginStandup, isSubmitted } from '../service/standupFlow.js';
import {
  addDays,
  endOfMonth,
  endOfWeek,
  formatKorean,
  isValidHm,
  isValidYmd,
  startOfMonth,
  startOfWeek,
  zonedToUtc,
  type Ymd,
} from '../util/time.js';
import {
  actions,
  blocks,
  button,
  codeBlocks,
  context,
  divider,
  mrkdwnSections,
  section,
} from './blocks/common.js';
import { settingsModal } from './blocks/home.js';
import { milestoneList, milestoneModal } from './blocks/milestone.js';
import { COPY } from './copy.js';
import { ACTION } from './ids.js';
import { dmChannel, postDm, postToBoard } from './notify.js';

/**
 * 명령 결과를 **DM 에 실제 메시지로** 남긴다.
 *
 * 임시(ephemeral) 응답은 새로고침하면 사라져서 "내가 뭘 기록했더라" 를 되짚을 수 없다.
 * 기록성 명령(출근·퇴근·완료)은 대화에 쌓여야 한다.
 * 채널에서 부른 경우에만 그 자리에도 짧게 알려 준다.
 */
async function record(
  client: WebClient,
  user: UserRow,
  channelId: string,
  text: string,
  respond: (payload: { response_type: 'ephemeral'; text: string }) => Promise<unknown>,
): Promise<void> {
  await postDm(client, user, blocks(section(text)), text);
  if (!channelId.startsWith('D')) {
    await respond({ response_type: 'ephemeral', text });
  }
}

const REPORT_USAGE = `기간을 못 알아들었습니다. 이렇게 쓰세요.
\`/report\` 오늘 · \`/report 주간\` · \`/report 월간\`
\`/report 지난주\` · \`/report 지난달\`
\`/report 2026-09-05\` 하루 · \`/report 2026-08\` 그 달
\`/report 2026-09-01~2026-09-10\` 구간 · \`/report 30일\` 최근 N일
뒤에 \`공유\` 를 붙이면 채널에, \`파일\` 을 붙이면 파일로 보냅니다.`;

/**
 * 긴 보고서는 파일로 보낸다.
 *
 * 슬랙 메시지는 블록당 3000자라 몇 주치가 넘어가면 잘린다.
 * 파일은 통째로 남고 내려받을 수도 있다. `files:write` 스코프가 필요하다.
 */
async function sendAsFile(
  client: WebClient,
  user: UserRow,
  title: string,
  content: string,
  respond: (payload: { response_type: 'ephemeral'; text: string }) => Promise<unknown>,
): Promise<void> {
  const channel = await dmChannel(client, user);
  if (!channel) {
    await respond({ response_type: 'ephemeral', text: 'DM 채널을 열지 못했습니다.' });
    return;
  }
  try {
    await client.filesUploadV2({
      channel_id: channel,
      filename: `${title.replace(/[^\w가-힣.-]+/g, '_')}.md`,
      title,
      content,
      initial_comment: `📄 ${title}`,
    });
    await respond({ response_type: 'ephemeral', text: 'DM 으로 파일을 보냈습니다.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missingScope = /missing_scope|not_allowed_token_type/.test(message);
    await respond({
      response_type: 'ephemeral',
      text: missingScope
        ? '파일로 보내려면 앱에 `files:write` 권한이 필요합니다.\nmanifest 를 다시 적용하고 앱을 재설치해 주세요.'
        : `파일 전송에 실패했습니다: ${message}`,
    });
  }
}

export function registerCommands(app: App): void {
  // ── 출근 ────────────────────────────────────────────────────────
  app.command(/^\/(출근|in)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    await record(client, user, command.channel_id, doClockIn(user), respond);
    await publishHome(client, user);
  });

  // ── 퇴근 ────────────────────────────────────────────────────────
  app.command(/^\/(퇴근|out)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    await record(client, user, command.channel_id, doClockOut(user), respond);
    await publishHome(client, user);
  });

  // ── 근무시간 ────────────────────────────────────────────────────
  app.command(/^\/(근무|hours)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const args = (command.text ?? '').trim().split(/\s+/).filter(Boolean);

    // /근무 수정 [YYYY-MM-DD] <출근 HH:MM> <퇴근 HH:MM>
    if (args[0] && /^(수정|edit|fix)$/i.test(args[0])) {
      await respond({ response_type: 'ephemeral', text: correctAttendance(user, args.slice(1), today) });
      await publishHome(client, user);
      return;
    }

    // 살아 있는 화면이므로 아직 퇴근 안 찍은 오늘도 "지금까지" 로 세어 넣는다.
    const live = { includeOpen: true };
    const day = summarize(user, today, today, today, live);
    const week = summarize(user, startOfWeek(today), endOfWeek(today), today, live);
    const month = summarize(user, startOfMonth(today), endOfMonth(today), today, live);

    await respond({
      response_type: 'ephemeral',
      text: '근무시간',
      blocks: blocks(
        section(
          `*근무시간* — ${formatKorean(today)}\n` +
            `• 오늘 *${formatDuration(day.totalMinutes)}*\n` +
            `• 이번 주 *${formatDuration(week.totalMinutes)}* (${week.days}일, 하루 평균 ${formatDuration(week.averageMinutes)})\n` +
            `• 이번 달 *${formatDuration(month.totalMinutes)}* (${month.days}일, 하루 평균 ${formatDuration(month.averageMinutes)})`,
        ),
        month.missingDays > 0
          ? context(`이번 달 기록이 없는 근무일이 ${month.missingDays}일 있습니다.`)
          : null,
      ),
    });
  });

  // ── done-next 지금 시작 ─────────────────────────────────────────
  app.command(/^\/(standup|마무리|퇴근보고)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const restart = /다시|restart|again/.test(command.text ?? '');

    if (isSubmitted(user.slack_user_id, today) && !restart) {
      await respond({
        response_type: 'ephemeral',
        text: COPY.standup.alreadyDone(formatKorean(today)),
      });
      return;
    }

    if (restart) {
      await respond({ response_type: 'ephemeral', text: COPY.standup.restarted });
    } else {
      await respond({ response_type: 'ephemeral', text: 'DM 으로 질문을 보냈습니다.' });
    }
    await beginStandup(client, user, today);
  });

  // ── 오늘 할 일 정하기 ───────────────────────────────────────────
  // 모달이 아니라 DM 대화다. 질문·답변·확인이 전부 대화 기록으로 남아야 하기 때문이다.
  app.command(/^\/(checkin|체크인|할일)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const inDm = command.channel_id.startsWith('D');
    await beginCheckin(client, user, todayFor(user), inDm ? command.channel_id : undefined);
    if (!inDm) {
      await respond({ response_type: 'ephemeral', text: 'DM 으로 여쭤봤습니다.' });
    }
  });

  // ── 중간 점검 지금 시작 ─────────────────────────────────────────
  app.command(/^\/(progress|중간보고|현황)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const inDm = command.channel_id.startsWith('D');
    await beginMidday(client, user, todayFor(user), inDm ? command.channel_id : undefined);
    if (!inDm) await respond({ response_type: 'ephemeral', text: 'DM 으로 여쭤봤습니다.' });
  });

  // ── 방금 끝낸 일 기록 ───────────────────────────────────────────
  app.command(/^\/(done|완료)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const title = (command.text ?? '').trim();

    if (!title) {
      await respond({
        response_type: 'ephemeral',
        text: '오늘 할 일',
        blocks: blocks(...planView(user, today), context('`/done 내용` 처럼 적으면 바로 완료로 기록됩니다.')),
      });
      return;
    }

    addTask({ userId: user.slack_user_id, workday: today, title, status: 'done', source: 'done' });
    await record(client, user, command.channel_id, `✅ 완료 — ${title}`, respond);
    await publishHome(client, user);
  });

  // ── 오늘 계획 보기 ──────────────────────────────────────────────
  app.command(/^\/(plan|계획)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    await respond({
      response_type: 'ephemeral',
      text: '오늘 계획',
      blocks: planView(user, todayFor(user)),
    });
  });

  // ── 마일스톤 ────────────────────────────────────────────────────
  app.command(/^\/(milestone|마일스톤)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const args = (command.text ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase() ?? '';

    if (sub === 'new' || sub === '새로' || sub === '추가') {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: milestoneModal({ responseChannel: command.channel_id }),
      });
      return;
    }

    if (sub === 'progress' || sub === '진행도') {
      const id = Number(args[1]);
      const pct = Number(args[2]);
      if (!Number.isInteger(id) || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        await respond({
          response_type: 'ephemeral',
          text: '사용법: `/milestone progress <번호> <0~100>`',
        });
        return;
      }
      updateMilestone(id, { progress_mode: 'manual', manual_progress: Math.round(pct) });
      const target = getMilestone(id);
      await record(
        client,
        user,
        command.channel_id,
        `🎯 *${target?.title ?? `#${id}`}* 진행도를 *${Math.round(pct)}%* 로 바꿨습니다.`,
        respond,
      );
      await publishHome(client, user);
      return;
    }

    if (sub === 'done' || sub === '완료') {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) {
        await respond({ response_type: 'ephemeral', text: '사용법: `/milestone done <번호>`' });
        return;
      }
      const finished = getMilestone(id);
      updateMilestone(id, { status: 'done', completed_at: new Date().toISOString() });
      await record(
        client,
        user,
        command.channel_id,
        `🎉 마일스톤 *${finished?.title ?? `#${id}`}* 완료!`,
        respond,
      );
      await publishHome(client, user);
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: '마일스톤',
      blocks: milestoneList(listMilestones(user.slack_user_id), today),
    });
  });

  // ── 업무보고 ────────────────────────────────────────────────────
  // 기간을 자유롭게 받는다: 오늘/주간/월간/지난주/지난달/날짜/구간/최근 N일
  app.command(/^\/(report|보고|업무보고)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const raw = (command.text ?? '').trim();

    const share = /공유|share/i.test(raw);
    const asFile = /파일|file/i.test(raw);
    const spec = raw.replace(/공유|share|파일|file/gi, '').trim();

    const range = parseRange(spec, today);
    if (!range) {
      await respond({ response_type: 'ephemeral', text: REPORT_USAGE });
      return;
    }

    const report = buildReport(user, range, today);

    if (asFile) {
      await sendAsFile(client, user, `업무보고 ${range.label}`, report, respond);
      return;
    }

    if (share) {
      const posted = await postToBoard(
        client,
        user,
        blocks(section(`<@${user.slack_user_id}> 의 *${range.label}* 업무보고`), ...codeBlocks(report)),
        `${range.label} 업무보고`,
      );
      await respond({
        response_type: 'ephemeral',
        text: posted
          ? '채널에 공유했습니다.'
          : '공유할 보드 채널이 설정되지 않았습니다. `/settings` 에서 지정하세요.',
      });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: `${range.label} 업무보고`,
      blocks: blocks(
        section(`*${range.label} 업무보고* — 아래를 그대로 복사해서 쓰세요.`),
        ...codeBlocks(report),
        context('`공유` 를 붙이면 채널에, `파일` 을 붙이면 파일로 보냅니다. 기간은 `/report 지난달` 처럼.'),
      ),
    });
  });

  // ── 지나온 날들 훑어보기 ────────────────────────────────────────
  app.command(/^\/(history|기록|히스토리)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const raw = (command.text ?? '').trim();

    const asFile = /파일|file/i.test(raw);
    const spec = raw.replace(/파일|file/gi, '').trim();
    const range = parseRange(spec.length > 0 ? spec : '14일', today);
    if (!range) {
      await respond({ response_type: 'ephemeral', text: REPORT_USAGE });
      return;
    }

    const days = buildHistory(user, range.from, range.to);
    const lines = historyLines(days);
    const submitted = days.filter((d) => d.submitted).length;
    const expected = days.filter((d) => d.workday && d.date <= today).length;
    const worked = days.reduce((sum, d) => sum + (d.workedMinutes ?? 0), 0);
    const doneCount = days.reduce((sum, d) => sum + d.done, 0);
    const head =
      `*${range.label}* · 회고 ${submitted}/${expected}일 · 완료 ${doneCount}건 · 근무 ${formatDuration(worked)}`;

    if (asFile) {
      await sendAsFile(client, user, `기록 ${range.label}`, [head, '', ...lines].join('\n'), respond);
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: `${range.label} 기록`,
      blocks: blocks(
        section(head),
        ...mrkdwnSections(lines),
        context('`/history 지난달`, `/history 30일`, `/history 파일` 처럼 쓸 수 있습니다.'),
      ),
    });
  });

  // ── 연속 기록 ───────────────────────────────────────────────────
  app.command(/^\/(streak|연속)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const streak = getStreak(user.slack_user_id);
    const badge = streakBadge(streak.current);
    const submittedToday = isSubmitted(user.slack_user_id, today);

    await respond({
      response_type: 'ephemeral',
      text: '연속 기록',
      blocks: blocks(
        section(
          `${badge} *연속 ${streak.current}일*\n최장 ${streak.longest}일 · 누적 ${streak.total_days}일\n마지막 기록 ${streak.last_workday ?? '없음'}`,
        ),
        context(
          submittedToday
            ? '오늘 보고는 이미 제출했습니다.'
            : '오늘 보고를 내면 기록이 하루 늘어납니다.',
        ),
      ),
    });
  });

  // ── 휴가 ────────────────────────────────────────────────────────
  app.command(/^\/(pause|휴가|자리비움)$/, async ({ ack, command, client, respond }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    const today = todayFor(user);
    const arg = (command.text ?? '').trim();

    if (arg === '해제' || arg === 'off' || arg === 'cancel') {
      updateUser(user.slack_user_id, { paused_until: null });
      await record(
        client,
        user,
        command.channel_id,
        ':arrow_forward: 휴가를 해제했습니다. 내일부터 다시 물어볼게요.',
        respond,
      );
      return;
    }

    let until: string | null = null;
    if (isValidYmd(arg)) until = arg;
    else if (/^\d+$/.test(arg)) until = addDays(today, Math.max(1, Number(arg)) - 1);

    if (!until) {
      await respond({
        response_type: 'ephemeral',
        text: '사용법: `/pause 3` (오늘부터 3일) 또는 `/pause 2026-09-20`, 해제는 `/pause 해제`',
      });
      return;
    }

    updateUser(user.slack_user_id, { paused_until: until });
    await record(
      client,
      user,
      command.channel_id,
      `:palm_tree: *${formatKorean(until)}* 까지 쉬는 것으로 해 뒀습니다.\n그동안은 안 물어보고, 연속 기록도 안 끊깁니다.`,
      respond,
    );
  });

  // ── 설정 ────────────────────────────────────────────────────────
  app.command(/^\/(settings|설정)$/, async ({ ack, command, client }) => {
    await ack();
    const user = await resolveUser(client, command.user_id, command.team_id);
    await client.views.open({
      trigger_id: command.trigger_id,
      view: settingsModal(user, user.board_channel_id),
    });
  });

  // ── 도움말 ──────────────────────────────────────────────────────
  app.command(/^\/(help|도움말)$/, async ({ ack, respond }) => {
    await ack();
    await respond({ response_type: 'ephemeral', text: COPY.help });
  });
}

/**
 * `/근무 수정` 인자 처리.
 * 자동 마감(기본 8시간)이 실제와 다를 때 손으로 바로잡는 통로다.
 */
function correctAttendance(user: UserRow, args: string[], today: Ymd): string {
  const usage =
    '사용법: `/근무 수정 09:00 18:00` (오늘) 또는 `/근무 수정 2026-09-16 09:00 18:00`';

  let workday = today;
  let times = args;
  if (args[0] && isValidYmd(args[0])) {
    workday = args[0];
    times = args.slice(1);
  }

  const [inTime, outTime] = times;
  if (!inTime || !outTime || !isValidHm(inTime) || !isValidHm(outTime)) return usage;

  const clockIn = zonedToUtc(workday, pad(inTime), user.tz);
  let clockOut = zonedToUtc(workday, pad(outTime), user.tz);
  // 자정을 넘긴 근무 — 퇴근이 출근보다 앞서면 다음 날로 본다
  if (clockOut.getTime() <= clockIn.getTime()) {
    clockOut = zonedToUtc(addDays(workday, 1), pad(outTime), user.tz);
  }

  const row = setManualAttendance(
    user.slack_user_id,
    workday,
    clockIn.toISOString(),
    clockOut.toISOString(),
    user.tz,
  );
  const brk = row.break_minutes > 0 ? ` (휴게 ${row.break_minutes}분 제외)` : '';
  return `${formatKorean(workday)} 근무를 ${pad(inTime)} ~ ${pad(outTime)} · *${formatDuration(row.worked_minutes ?? 0)}*${brk} 로 고쳤습니다.`;
}

/** '9:00' → '09:00' */
function pad(time: string): string {
  const [h, m] = time.trim().split(':');
  return `${(h ?? '0').padStart(2, '0')}:${m ?? '00'}`;
}

/** 오늘 보고를 아직 안 냈으면 true — 스케줄러와 명령이 함께 쓴다 */
export function needsStandup(userId: string, workday: string): boolean {
  return getStandup(userId, workday)?.submitted_at == null;
}
