/**
 * 날짜/시간 도우미.
 *
 * 이 앱에서 "날짜"는 언제나 사용자 타임존 기준의 `YYYY-MM-DD` 문자열이다.
 * Date 객체를 들고 다니면 UTC 자정 경계에서 하루가 밀린다 — 그래서 문자열로 고정한다.
 * 날짜 산술은 UTC 자정 Date 로 바꿔서 하고 다시 문자열로 돌린다 (DST 영향 없음).
 */

export type Ymd = string; // 'YYYY-MM-DD'

/** 사용자 타임존 기준의 지금. weekday 는 1=월 … 7=일. */
export function nowInTz(tz: string, at: Date = new Date()): {
  date: Ymd;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';

  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    date,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdayOf(date),
  };
}

/** 'YYYY-MM-DD' → 1=월 … 7=일 */
export function weekdayOf(date: Ymd): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=일
  return d === 0 ? 7 : d;
}

export function addDays(date: Ymd, days: number): Ymd {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: Ymd, to: Ymd): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** date 가 속한 주의 월요일 */
export function startOfWeek(date: Ymd): Ymd {
  return addDays(date, -(weekdayOf(date) - 1));
}

export function endOfWeek(date: Ymd): Ymd {
  return addDays(startOfWeek(date), 6);
}

export function startOfMonth(date: Ymd): Ymd {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: Ymd): Ymd {
  const d = new Date(`${startOfMonth(date)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

const KOREAN_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;

export function weekdayLabel(date: Ymd): string {
  return KOREAN_WEEKDAYS[weekdayOf(date) - 1] ?? '?';
}

/** '2026-09-09' → '9월 9일(수)' */
export function formatKorean(date: Ymd): string {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return `${month}월 ${day}일(${weekdayLabel(date)})`;
}

/** '2026-09-09' → '2026-09-09 (수)' — 보고서용 */
export function formatIsoWithDay(date: Ymd): string {
  return `${date} (${weekdayLabel(date)})`;
}

export function isValidYmd(value: string): value is Ymd {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** workDays 를 고려한 직전 근무일 (최대 14일까지 되짚는다) */
export function previousWorkday(date: Ymd, workDays: number[]): Ymd | null {
  for (let i = 1; i <= 14; i++) {
    const candidate = addDays(date, -i);
    if (workDays.includes(weekdayOf(candidate))) return candidate;
  }
  return null;
}

export function isWorkday(date: Ymd, workDays: number[]): boolean {
  return workDays.includes(weekdayOf(date));
}

/** 사용자 타임존의 벽시계 시각을 'YYYY-MM-DDTHH:MM:SS' 로 (UTC 표기 없이) */
function wallClock(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const g = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}

/**
 * "그 타임존에서 이 날짜 이 시각" 이 가리키는 실제 순간(UTC).
 *
 * 타임존 라이브러리 없이 계산한다. 벽시계를 UTC 로 읽은 값과 실제 렌더링의 차이를
 * 두 번 보정하면 DST 경계에서도 수렴한다.
 */
export function zonedToUtc(date: Ymd, time: string, tz: string): Date {
  const target = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  let instant = target;
  for (let i = 0; i < 2; i++) {
    const shown = Date.parse(`${wallClock(new Date(instant), tz)}Z`);
    const drift = target - shown;
    if (drift === 0) break;
    instant += drift;
  }
  return new Date(instant);
}

/** 'HH:MM' 형식인지 */
export function isValidHm(value: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}
