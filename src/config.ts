import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다. .env.example 을 참고하세요.`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/** "09:00" → { hour: 9, minute: 0 } */
export function parseHm(value: string, label: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`${label} 의 형식이 잘못됐습니다: "${value}" (예: 17:50)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} 의 시각이 범위를 벗어났습니다: "${value}"`);
  return { hour, minute };
}

/** "1,2,3,4,5" → [1,2,3,4,5] (1=월 … 7=일) */
export function parseWorkDays(value: string): number[] {
  const days = value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return days.length > 0 ? [...new Set(days)].sort() : [1, 2, 3, 4, 5];
}

/**
 * 토큰이 접두사만 남아 있으면 부팅은 되고 슬랙 호출에서 invalid_auth 로 죽는다.
 * 스택트레이스 대신 무엇을 어디서 가져와야 하는지 알려 준다.
 */
function requireToken(name: string, prefix: string, where: string): string {
  const value = required(name).trim();
  if (!value.startsWith(prefix) || value.length < prefix.length + 10) {
    throw new Error(
      `${name} 이 아직 채워지지 않았습니다 (현재 값: "${value}").\n` +
        `  .env 를 열어 ${prefix}… 로 시작하는 진짜 토큰을 붙여넣으세요.\n` +
        `  받는 곳: ${where}`,
    );
  }
  return value;
}

const mode = optional('SLACK_MODE', 'socket');
if (mode !== 'socket' && mode !== 'http') {
  throw new Error(`SLACK_MODE 는 socket 또는 http 여야 합니다 (받은 값: ${mode})`);
}

export const config = {
  slack: {
    botToken: requireToken(
      'SLACK_BOT_TOKEN',
      'xoxb-',
      'api.slack.com/apps → 내 앱 → OAuth & Permissions → Bot User OAuth Token (먼저 Install to Workspace 를 해야 생깁니다)',
    ),
    mode: mode as 'socket' | 'http',
    appToken:
      mode === 'socket'
        ? requireToken(
            'SLACK_APP_TOKEN',
            'xapp-',
            'api.slack.com/apps → 내 앱 → Basic Information → App-Level Tokens → 토큰 이름 클릭',
          )
        : '',
    signingSecret: mode === 'http' ? required('SLACK_SIGNING_SECRET') : '',
    port: Number(optional('PORT', '3000')),
  },
  databasePath: optional('DATABASE_PATH', './data/worklife.sqlite'),
  board: {
    /**
     * 개개인의 보고 요약이 올라갈 공개 채널.
     * 비워 두면 봇이 들어가 있는 채널 중 하나를 자동으로 고르는데,
     * 채널이 둘 이상이면 어느 쪽이 잡힐지 단정할 수 없다. 운영에서는 반드시 지정할 것.
     */
    channelId: optional('BOARD_CHANNEL_ID', ''),
  },
  defaults: {
    tz: optional('DEFAULT_TZ', 'Asia/Seoul'),
    workDays: optional('DEFAULT_WORK_DAYS', '1,2,3,4,5'),
    checkinTime: optional('DEFAULT_CHECKIN_TIME', '09:00'),
    standupTime: optional('DEFAULT_STANDUP_TIME', '17:50'),
    nudgeTime: optional('DEFAULT_NUDGE_TIME', '18:40'),
    weeklyTime: optional('DEFAULT_WEEKLY_TIME', '17:00'),
  },
  attendance: {
    /**
     * 점심시간은 "길이" 가 아니라 "구간" 이다.
     * 근무 구간과 겹치는 만큼만 뺀다 — 오전만 일한 날에 1시간 30분을 빼면 안 된다.
     */
    lunchStart: optional('LUNCH_START', '12:30'),
    lunchEnd: optional('LUNCH_END', '14:00'),
    /** 정규 퇴근 시각. 퇴근을 안 찍은 날은 이 시각으로 마감한다 */
    defaultClockOut: optional('DEFAULT_CLOCK_OUT', '18:00'),
    /**
     * 정규 퇴근 시각을 이미 지나서 출근을 찍은 날의 대비책(시).
     * 출근 기록이 아예 없는 날은 0 이다 — 기본값은 "출근은 했는데 퇴근을 안 찍은" 날에만 쓴다.
     */
    defaultWorkHours: Number(optional('DEFAULT_WORK_HOURS', '7')),
  },
  logLevel: optional('LOG_LEVEL', 'info'),
} as const;

// 부팅 시점에 형식 오류를 잡는다 — 스케줄러가 조용히 안 도는 것보다 낫다.
parseHm(config.defaults.checkinTime, 'DEFAULT_CHECKIN_TIME');
parseHm(config.defaults.standupTime, 'DEFAULT_STANDUP_TIME');
parseHm(config.defaults.nudgeTime, 'DEFAULT_NUDGE_TIME');
parseHm(config.attendance.lunchStart, 'LUNCH_START');
parseHm(config.attendance.lunchEnd, 'LUNCH_END');
parseHm(config.attendance.defaultClockOut, 'DEFAULT_CLOCK_OUT');
parseHm(config.defaults.weeklyTime, 'DEFAULT_WEEKLY_TIME');
