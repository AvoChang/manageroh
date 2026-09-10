import type { KnownBlock } from '@slack/types';
import type { MilestoneRow, StandupRow, TaskRow } from '../../db/types.js';
import { deadlineLabel, progressBar, progressOf } from '../../domain/milestone.js';
import { splitItems } from '../../domain/textItems.js';
import { formatKorean, type Ymd } from '../../util/time.js';
import { ACTION } from '../ids.js';
import { COPY } from '../copy.js';
import { actions, blocks, button, context, divider, escapeMrkdwn, section } from './common.js';

/** 자유 서술 답변을 불릿 배열로 — 저장은 원문 그대로, 표시할 때만 정리한다 */
export function toBullets(text: string, limit = 12): string[] {
  return splitItems(text, limit);
}

/** 17:50 첫 메시지 — 인사 */
export function standupGreeting(name: string): KnownBlock[] {
  return blocks(section(COPY.standup.greeting(name)));
}

/**
 * 질문 1. 지난 보고의 NEXT 를 인용해서 같이 보여준다.
 * "어제 뭘 하겠다고 했는지" 를 보여 주는 것이 이 흐름의 핵심이다 —
 * 빈 화면에서 기억을 짜내는 것과 목록을 보고 고치는 것은 전혀 다른 일이다.
 */
export function standupQuestion1(previousNext: string[]): KnownBlock[] {
  const quote =
    previousNext.length > 0
      ? `\n\n${COPY.standup.q1PreviousHeader}\n${previousNext.map((l) => `• ${escapeMrkdwn(l)}`).join('\n')}`
      : '';
  return blocks(section(`${COPY.standup.q1}${quote}`));
}

export function standupQuestion2(): KnownBlock[] {
  return blocks(section(COPY.standup.q2));
}

export function standupQuestion3(): KnownBlock[] {
  return blocks(section(COPY.standup.q3));
}

/** 3번 질문까지 끝난 뒤의 마무리 — 오늘의 성적표 */
export function standupClosing(opts: {
  workday: Ymd;
  streak: number;
  badge: string;
  workedLabel: string | null;
  boardPosted: boolean;
}): KnownBlock[] {
  const lines = [COPY.standup.thanks];
  const facts: string[] = [`${opts.badge} 연속 *${opts.streak}일째*`];
  if (opts.workedLabel) facts.push(`오늘 근무 *${opts.workedLabel}*`);
  if (opts.boardPosted) facts.push('채널에 공유했습니다');

  return blocks(
    section(lines.join('\n')),
    context(`${formatKorean(opts.workday)} · ${facts.join(' · ')}`),
    actions([
      button({ text: '보고서 보기', actionId: `${ACTION.reportPeriod}_today`, value: 'today' }),
      button({ text: '마일스톤', actionId: ACTION.openMilestoneList }),
    ]),
  );
}

/** 미제출자에게 보내는 넛지 (하루 한 번) */
export function nudgeMessage(workday: Ymd, streak: number): KnownBlock[] {
  const tail =
    streak > 0 ? `지금 적으면 연속 ${streak}일 기록이 이어집니다.` : COPY.standup.nudge;
  return blocks(
    section(`아직 *${formatKorean(workday)}* 마무리가 안 됐습니다.\n${tail}`),
    actions([button({ text: '지금 마무리하기', actionId: ACTION.openStandup, style: 'primary' })]),
  );
}

/** 공개 보드 채널에 올리는 요약 */
export function boardPost(opts: {
  userId: string;
  workday: Ymd;
  standup: StandupRow;
  streak: number;
  badge: string;
  workedLabel: string | null;
}): KnownBlock[] {
  const done = toBullets(opts.standup.done_text);
  const next = toBullets(opts.standup.next_text);
  const meta = [`${opts.badge} ${opts.streak}일째`];
  if (opts.workedLabel) meta.push(`근무 ${opts.workedLabel}`);

  return blocks(
    section(`<@${opts.userId}> 의 *${formatKorean(opts.workday)}* 마무리  ·  ${meta.join(' · ')}`),
    done.length > 0 ? section(`*DONE*\n${done.map((l) => `• ${escapeMrkdwn(l)}`).join('\n')}`) : null,
    next.length > 0 ? section(`*NEXT*\n${next.map((l) => `• ${escapeMrkdwn(l)}`).join('\n')}`) : null,
    opts.standup.note_to_self.trim()
      ? context(`:speech_balloon: _${escapeMrkdwn(opts.standup.note_to_self.trim())}_`)
      : null,
    divider(),
  );
}

/**
 * 아침 리마인드 — **어제 봇 DM 에 쌓인 기록을 통째로 되짚어 준다.**
 *
 * 원래 09:30 에 따로 "아카이브 확인" 알림을 두려 했는데, 아침에 두 번 울리는 것보다
 * 이 한 통에 다 담는 편이 낫다고 판단했다. 여기서 말하는 아카이브는
 * self-DM 이 아니라 **이 봇과의 DM 에 쌓인 기록**이다 — 내용이 전부 DB 에 있으므로
 * 링크로 내보낼 이유가 없다.
 */
export function morningMessage(opts: {
  name: string;
  workday: Ymd;
  yesterday: { date: Ymd; done: string[]; note: string } | null;
  todayPlan: string[];
  carryOver: TaskRow[];
  milestones: MilestoneRow[];
  streak: number;
  badge: string;
  working: boolean;
}): KnownBlock[] {
  const bullets = (items: string[]): string =>
    items.map((l) => `• ${escapeMrkdwn(l)}`).join('\n');

  const yesterdayDone =
    opts.yesterday && opts.yesterday.done.length > 0
      ? section(
          `*${COPY.morning.doneHeader(formatKorean(opts.yesterday.date))}*\n${bullets(opts.yesterday.done)}`,
        )
      : null;

  const plan =
    opts.todayPlan.length > 0
      ? section(`*${COPY.morning.plannedHeader}*\n${bullets(opts.todayPlan)}`)
      : section(opts.yesterday ? COPY.morning.noPlan : COPY.morning.noRecord);

  const carry =
    opts.carryOver.length > 0
      ? section(
          `*${COPY.morning.carryHeader}*\n${bullets(opts.carryOver.slice(0, 5).map((t) => t.title))}`,
        )
      : null;

  const note =
    opts.yesterday && opts.yesterday.note.trim()
      ? context(`:speech_balloon: _${escapeMrkdwn(opts.yesterday.note.trim())}_`)
      : null;

  const active = opts.milestones.filter((m) => m.status === 'active').slice(0, 3);
  const milestones =
    active.length > 0
      ? section(
          `*${COPY.morning.milestoneHeader}*\n${active
            .map((m) => {
              const p = progressOf(m, opts.workday);
              return `${p.behind ? '⚠️' : '🎯'} ${escapeMrkdwn(m.title)}  \`${progressBar(p.percent)}\` ${p.percent}% · ${deadlineLabel(p)}`;
            })
            .join('\n')}`,
        )
      : null;

  const routine = section(
    `*${COPY.morning.routineHeader}*\n${COPY.morning.routine
      .map((item, i) => `${i + 1}. ${item}`)
      .join('\n')}`,
  );

  return blocks(
    section(`${COPY.morning.greeting(opts.name)} *${formatKorean(opts.workday)}* 입니다.`),
    routine,
    divider(),
    yesterdayDone,
    plan,
    carry,
    note,
    milestones,
    actions([
      ...(opts.working
        ? []
        : [button({ text: '출근하기', actionId: ACTION.clockIn, style: 'primary' as const })]),
      button({ text: '오늘 할 일 정하기', actionId: ACTION.openCheckin }),
    ]),
    opts.streak > 0 ? context(`${opts.badge} 연속 ${opts.streak}일째 기록 중입니다.`) : null,
  );
}
