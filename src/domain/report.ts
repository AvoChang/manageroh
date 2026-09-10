import { listMilestones } from '../db/milestones.js';
import { standupsInRange } from '../db/standups.js';
import { tasksInRange } from '../db/tasks.js';
import type { UserRow } from '../db/types.js';
import { workDaysOf } from '../db/users.js';
import { getStreak } from '../db/streaks.js';
import { attendanceInRange } from '../db/attendance.js';
import {
  addDays,
  endOfMonth,
  endOfWeek,
  formatIsoWithDay,
  isValidYmd,
  isWorkday,
  startOfMonth,
  startOfWeek,
  weekdayLabel,
  type Ymd,
} from '../util/time.js';
import { formatDuration, localTime, summarize } from './attendance.js';
import { deadlineLabel, progressBar, progressOf } from './milestone.js';
import { splitItems } from './textItems.js';

export type ReportPeriod = 'today' | 'week' | 'month';

export interface ReportRange {
  from: Ymd;
  to: Ymd;
  label: string;
}

export function rangeFor(period: ReportPeriod, today: Ymd): ReportRange {
  switch (period) {
    case 'today':
      return { from: today, to: today, label: formatIsoWithDay(today) };
    case 'week': {
      const from = startOfWeek(today);
      const to = endOfWeek(today);
      return { from, to, label: `${from} ~ ${to} 주간` };
    }
    case 'month': {
      const from = startOfMonth(today);
      const to = endOfMonth(today);
      return { from, to, label: `${from.slice(0, 7)} 월간` };
    }
  }
}

/**
 * 사람이 적은 기간 표현을 구간으로 바꾼다.
 *
 * 예전에는 오늘·이번주·이번달 세 가지뿐이었다. 회고가 목적인 앱인데
 * "지난달엔 뭐 했더라" 를 못 보는 건 구멍이라 임의 구간을 열었다.
 * 못 알아들으면 null 을 주고, 부르는 쪽이 사용법을 안내한다.
 */
export function parseRange(input: string, today: Ymd): ReportRange | null {
  const text = input.trim().toLowerCase();
  if (text.length === 0) return rangeFor('today', today);

  // 2026-09-01~2026-09-10 (~ .. to 모두 허용)
  const span = /(\d{4}-\d{2}-\d{2})\s*(?:~|\.\.|to)\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (span) {
    const [from, to] = [span[1]!, span[2]!].sort();
    if (isValidYmd(from!) && isValidYmd(to!)) return { from: from!, to: to!, label: `${from} ~ ${to}` };
  }

  // 하루: 2026-09-05
  const oneDay = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (oneDay && isValidYmd(oneDay[1]!)) {
    return { from: oneDay[1]!, to: oneDay[1]!, label: formatIsoWithDay(oneDay[1]!) };
  }

  // 특정 달: 2026-08
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const first = `${month[1]}-${month[2]}-01`;
    if (isValidYmd(first)) {
      return { from: first, to: endOfMonth(first), label: `${month[1]}-${month[2]} 월간` };
    }
  }

  // 최근 N일
  const recent = /^(?:최근\s*)?(\d{1,3})\s*(?:일|d|days?)$/.exec(text);
  if (recent) {
    const n = Math.min(365, Math.max(1, Number(recent[1])));
    const from = addDays(today, -(n - 1));
    return { from, to: today, label: `최근 ${n}일 (${from} ~ ${today})` };
  }

  // "지난주" 는 "주" 를 품고 있으니 프리셋보다 먼저 본다.
  if (/지난\s*주|저번\s*주|last\s*week/.test(text)) {
    const from = startOfWeek(addDays(today, -7));
    const to = endOfWeek(from);
    return { from, to, label: `${from} ~ ${to} 주간 (지난주)` };
  }
  if (/지난\s*달|저번\s*달|last\s*month/.test(text)) {
    const anchor = addDays(startOfMonth(today), -1);
    return {
      from: startOfMonth(anchor),
      to: endOfMonth(anchor),
      label: `${anchor.slice(0, 7)} 월간 (지난달)`,
    };
  }

  if (/week|주간|이번\s*주|^주$/.test(text)) return rangeFor('week', today);
  if (/month|월간|이번\s*달|^월$/.test(text)) return rangeFor('month', today);
  if (/today|오늘/.test(text)) return rangeFor('today', today);
  return null;
}

/**
 * 붙여넣기 가능한 마크다운 업무보고를 만든다.
 * 슬랙 메시지로도 쓰고, 사용자가 통째로 복사해 다른 곳에 붙이기도 한다.
 */
export function buildReport(user: UserRow, range: ReportRange, today: Ymd): string {
  const tasks = tasksInRange(user.slack_user_id, range.from, range.to);
  const standups = standupsInRange(user.slack_user_id, range.from, range.to);
  const done = tasks.filter((t) => t.status === 'done');
  const open = tasks.filter((t) => t.status === 'planned');
  const workDays = workDaysOf(user);

  const lines: string[] = [];
  lines.push(`# 업무보고 — ${range.label}`);
  lines.push('');

  // ── 완료 ────────────────────────────────────────────────────────
  lines.push(`## 완료 (${done.length}건)`);
  if (done.length === 0) {
    lines.push('- 기록된 완료 항목 없음');
  } else if (range.from === range.to) {
    for (const t of done) lines.push(`- ${t.title}`);
  } else {
    // 여러 날이면 날짜별로 묶는다 — 하루에 몰아서 한 건지 꾸준히 한 건지가 보인다.
    const byDay = new Map<string, string[]>();
    for (const t of done) {
      const list = byDay.get(t.workday) ?? [];
      list.push(t.title);
      byDay.set(t.workday, list);
    }
    for (const [day, titles] of [...byDay.entries()].sort()) {
      lines.push(`- **${formatIsoWithDay(day)}**`);
      for (const title of titles) lines.push(`  - ${title}`);
    }
  }
  lines.push('');

  // ── 진행 중 ─────────────────────────────────────────────────────
  lines.push(`## 진행 중 / 이월 (${open.length}건)`);
  if (open.length === 0) lines.push('- 없음');
  else for (const t of open) lines.push(`- ${t.title} _(${t.workday})_`);
  lines.push('');

  // ── 마일스톤 ────────────────────────────────────────────────────
  const milestones = listMilestones(user.slack_user_id, 'active');
  if (milestones.length > 0) {
    lines.push('## 마일스톤');
    for (const m of milestones) {
      const p = progressOf(m, today);
      const warn = p.behind ? ' ⚠️ 지연' : '';
      lines.push(`- **${m.title}** — ${progressBar(p.percent)} ${p.percent}% · ${deadlineLabel(p)}${warn}`);
    }
    lines.push('');
  }

  // ── 막힌 것 ─────────────────────────────────────────────────────
  const blockers = standups.filter((s) => s.blocker_text.trim().length > 0);
  if (blockers.length > 0) {
    lines.push('## 막힌 것 / 도움 필요');
    for (const s of blockers) lines.push(`- _(${s.workday})_ ${s.blocker_text.trim()}`);
    lines.push('');
  }

  // ── 다음 계획 ───────────────────────────────────────────────────
  const lastStandup = standups.at(-1);
  if (lastStandup && lastStandup.next_text.trim().length > 0) {
    lines.push('## 다음 계획');
    for (const line of splitItems(lastStandup.next_text)) lines.push(`- ${line}`);
    lines.push('');
  }

  // ── 근무시간 ────────────────────────────────────────────────────
  const attendance = summarize(user, range.from, range.to, today);
  if (attendance.days > 0) {
    lines.push('## 근무시간');
    if (range.from === range.to) {
      const row = attendance.rows[0];
      if (row?.clock_in) {
        const span = row.clock_out
          ? `${localTime(row.clock_in, user.tz)} ~ ${localTime(row.clock_out, user.tz)}`
          : `${localTime(row.clock_in, user.tz)} ~ (근무 중)`;
        lines.push(`- ${span} · ${formatDuration(row.worked_minutes ?? 0)}`);
      }
    } else {
      lines.push(`- 합계 ${formatDuration(attendance.totalMinutes)} (${attendance.days}일)`);
      lines.push(`- 하루 평균 ${formatDuration(attendance.averageMinutes)}`);
      if (attendance.missingDays > 0) lines.push(`- 기록 없는 근무일 ${attendance.missingDays}일`);
    }
    lines.push('');
  }

  // ── 나에게 한 말 ────────────────────────────────────────────────
  const notes = standups.filter((s) => s.note_to_self.trim().length > 0);
  if (notes.length > 0) {
    lines.push('## 나에게 한 말');
    for (const s of notes) lines.push(`- _(${s.workday})_ ${s.note_to_self.trim()}`);
    lines.push('');
  }

  // ── 통계 ────────────────────────────────────────────────────────
  if (range.from !== range.to) {
    const workdayCount = countWorkdays(range.from, range.to, workDays, today);
    const streak = getStreak(user.slack_user_id);
    const submitted = standups.filter((s) => s.submitted_at !== null).length;
    const rate = workdayCount === 0 ? 0 : Math.round((submitted / workdayCount) * 100);
    lines.push('## 기록');
    lines.push(`- 보고 제출: ${submitted}/${workdayCount}일 (${rate}%)`);
    lines.push(`- 완료/계획: ${done.length}/${tasks.length}건`);
    lines.push(`- 연속 기록: ${streak.current}일 (최장 ${streak.longest}일)`);
    const moods = standups.map((s) => s.mood).filter((m): m is number => m !== null);
    if (moods.length > 0) {
      const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
      lines.push(`- 평균 컨디션: ${avg.toFixed(1)}/5`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/** 범위 안의 근무일 수. 오늘 이후는 세지 않는다 (아직 안 온 날을 미제출로 치면 안 된다). */
function countWorkdays(from: Ymd, to: Ymd, workDays: number[], today: Ymd): number {
  const end = to < today ? to : today;
  let count = 0;
  let cursor = from;
  while (cursor <= end) {
    if (isWorkday(cursor, workDays)) count++;
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return count;
}



// ── 지나온 날들 훑어보기 ──────────────────────────────────────────

export interface HistoryDay {
  date: Ymd;
  planned: number;
  done: number;
  workedMinutes: number | null;
  submitted: boolean;
  workday: boolean;
}

/**
 * 날짜별 한 줄 요약.
 *
 * 구간 리포트가 "무엇을 했나" 라면 이건 "얼마나 꾸준했나" 를 본다.
 * 빈 날도 빼지 않는다 — 빠진 날이 보여야 리듬이 보인다.
 */
export function buildHistory(user: UserRow, from: Ymd, to: Ymd): HistoryDay[] {
  const workDays = workDaysOf(user);
  const tasks = tasksInRange(user.slack_user_id, from, to);
  const standups = standupsInRange(user.slack_user_id, from, to);
  const attendance = attendanceInRange(user.slack_user_id, from, to);

  const submitted = new Set(standups.filter((s) => s.submitted_at !== null).map((s) => s.workday));
  const worked = new Map(attendance.map((a) => [a.workday, a.worked_minutes]));

  const days: HistoryDay[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    const ofDay = tasks.filter((t) => t.workday === cursor);
    days.push({
      date: cursor,
      planned: ofDay.length,
      done: ofDay.filter((t) => t.status === 'done').length,
      workedMinutes: worked.get(cursor) ?? null,
      submitted: submitted.has(cursor),
      workday: isWorkday(cursor, workDays),
    });
  }
  return days;
}

/** 히스토리를 슬랙 mrkdwn 줄로 */
export function historyLines(days: HistoryDay[]): string[] {
  return days.map((d) => {
    const label = `\`${d.date.slice(5).replace('-', '/')} ${weekdayLabel(d.date)}\``;
    if (d.planned === 0 && d.workedMinutes === null && !d.submitted) {
      return `${label}  ${d.workday ? '— 기록 없음' : '· 쉬는 날'}`;
    }
    const parts: string[] = [];
    if (d.planned > 0) parts.push(`✅ ${d.done}/${d.planned}`);
    if (d.workedMinutes !== null) parts.push(`🏢 ${formatDuration(d.workedMinutes)}`);
    parts.push(d.submitted ? '📝 회고' : '📝 미제출');
    return `${label}  ${parts.join(' · ')}`;
  });
}
