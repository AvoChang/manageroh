/**
 * 슬랙 없이 도메인 로직만 돌려 보는 연기(smoke) 테스트.
 *   npx tsx scripts/smoke.ts
 *
 * 슬랙 앱을 만들기 전에 "계산이 맞는지" 를 확인하는 용도다.
 */
process.env['SLACK_BOT_TOKEN'] = 'xoxb-0000000000-smoke-test';
process.env['SLACK_APP_TOKEN'] = 'xapp-0000000000-smoke-test';
process.env['DATABASE_PATH'] = ':memory:';
process.env['LOG_LEVEL'] = 'warn';

const { ensureUser, updateUser } = await import('../src/db/users.js');
const { addTask, tasksForDay } = await import('../src/db/tasks.js');
const { saveAnswer, markSubmitted, lastSubmittedBefore, getStandup } = await import('../src/db/standups.js');
const { createMilestone } = await import('../src/db/milestones.js');
const { setTaskMilestone, milestoneTaskCounts } = await import('../src/db/tasks.js');
const { clockIn, clockOut, formatDuration, summarize } = await import('../src/domain/attendance.js');
const { getAttendance: getAttendanceRow } = await import('../src/db/attendance.js');
const { recordStandup, expectedNextWorkday } = await import('../src/domain/streak.js');
const { progressOf, progressBar } = await import('../src/domain/milestone.js');
const { buildReport } = await import('../src/domain/report.js');
const { addDays, startOfWeek, endOfWeek, zonedToUtc } = await import('../src/util/time.js');
const TZ = 'Asia/Seoul';
const kst = (d: string, t: string): Date => zonedToUtc(d, t, TZ);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `  기대=${JSON.stringify(expected)} 실제=${JSON.stringify(actual)}`}`);
}

const USER = 'U_TEST';
const user0 = ensureUser({ userId: USER, displayName: '테스터', tz: 'Asia/Seoul' });
updateUser(USER, { board_channel_id: 'C_BOARD' });

// 2026-09-07(월) ~ 2026-09-11(금) 한 주를 만든다
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';

console.log('\n── 날짜 ──');
check('다음 근무일(금→월)', expectedNextWorkday(user0, '2026-09-11'), '2026-09-14');
check('주 시작', startOfWeek(WED), MON);
check('주 끝', endOfWeek(WED), '2026-09-13');

console.log('\n── 할 일 · 마일스톤 ──');
const ms = createMilestone({ userId: USER, title: '포트폴리오 공개', targetDate: '2026-10-31' });
const t1 = addTask({ userId: USER, workday: MON, title: '이력서 정리', source: 'checkin' });
const t2 = addTask({ userId: USER, workday: MON, title: '사이트 뼈대', source: 'checkin' });
setTaskMilestone(t1.id, ms.id);
setTaskMilestone(t2.id, ms.id);
addTask({ userId: USER, workday: MON, title: '깃허브 정리', status: 'done', source: 'done' });

check('월요일 할 일 3개', tasksForDay(USER, MON).length, 3);
check('마일스톤 연결 2개', milestoneTaskCounts(ms.id), { total: 2, done: 0 });

const { setTaskStatus } = await import('../src/db/tasks.js');
setTaskStatus(t1.id, 'done');
check('마일스톤 진행도 50%', progressOf(ms, WED).percent, 50);
check('진행 막대', progressBar(50), '█████░░░░░');

console.log('\n── 연속 기록 ──');
saveAnswer(USER, MON, 'done_text', '- 이력서 정리\n- 깃허브 정리');
saveAnswer(USER, MON, 'next_text', '- 사이트 뼈대 잡기');
saveAnswer(USER, MON, 'note_to_self', '오늘 잘했다');
markSubmitted(USER, MON);
const s1 = recordStandup(user0, MON);
check('첫날 연속 1', s1.current, 1);

saveAnswer(USER, TUE, 'done_text', '- 사이트 뼈대');
markSubmitted(USER, TUE);
const s2 = recordStandup(user0, TUE);
check('이튿날 연속 2', s2.current, 2);

// 하루 건너뛰면 끊긴다
const THU = '2026-09-10';
markSubmitted(USER, THU);
const s3 = recordStandup(user0, THU);
check('하루 빠지면 1로 리셋', s3.current, 1);

check('직전 제출 보고 인용', lastSubmittedBefore(USER, TUE)?.next_text, '- 사이트 뼈대 잡기');

console.log('\n── 근무시간 (09:30~18:00 · 점심 12:30~14:00) ──');
const { computeWorked } = await import('../src/domain/attendance.js');

clockIn(USER, WED, kst(WED, '09:30'));
const out = clockOut(USER, WED, TZ, kst(WED, '18:00'));
check('정규 근무 = 7시간', out?.worked_minutes, 420);
check('점심 90분 차감', out?.break_minutes, 90);
check('표시', formatDuration(420), '7시간');

const worked = (from: string, to: string) =>
  computeWorked(kst(TUE, from).toISOString(), kst(TUE, to).toISOString(), TUE, TZ);
check('오전만 근무 → 점심 차감 없음', worked('09:30', '12:00'), { breakMinutes: 0, workedMinutes: 150 });
check('점심에 걸친 만큼만 차감', worked('09:30', '13:00'), { breakMinutes: 30, workedMinutes: 180 });
check('오후만 근무 → 차감 없음', worked('14:00', '18:00'), { breakMinutes: 0, workedMinutes: 240 });
check('점심 안에만 있으면 전부 차감', worked('12:45', '13:15'), { breakMinutes: 30, workedMinutes: 0 });

clockIn(USER, TUE, kst(TUE, '09:30'));
clockOut(USER, TUE, TZ, kst(TUE, '12:00'));
const week = summarize(user0, startOfWeek(WED), endOfWeek(WED), WED);
check('주간 합계 = 420 + 150', week.totalMinutes, 570);

console.log('\n── 기간 해석 ──');
const { parseRange, buildHistory, historyLines, rangeFor } = await import('../src/domain/report.js');
const R = (t: string) => {
  const r = parseRange(t, WED);
  return r ? `${r.from}~${r.to}` : null;
};
check('빈 입력 = 오늘', R(''), `${WED}~${WED}`);
check('이번주', R('주간'), '2026-09-07~2026-09-13');
check('지난주', R('지난주'), '2026-08-31~2026-09-06');
check('이번달', R('월간'), '2026-09-01~2026-09-30');
check('지난달', R('지난달'), '2026-08-01~2026-08-31');
check('특정 하루', R('2026-09-05'), '2026-09-05~2026-09-05');
check('특정 달', R('2026-08'), '2026-08-01~2026-08-31');
check('구간', R('2026-09-01~2026-09-10'), '2026-09-01~2026-09-10');
check('구간 뒤집혀도 정렬', R('2026-09-10~2026-09-01'), '2026-09-01~2026-09-10');
check('최근 N일', R('30일'), '2026-08-11~2026-09-09');
check('못 알아들으면 null', R('아무말'), null);

console.log('\n── 보고서 ──');
const report = buildReport(user0, rangeFor('week', WED), WED);
console.log(report.split('\n').map((l) => `   │ ${l}`).join('\n'));
check('보고서에 근무시간 포함', report.includes('## 근무시간'), true);
check('보고서에 나에게 한 말 포함', report.includes('오늘 잘했다'), true);

const pastReport = buildReport(user0, parseRange('2026-09-07', WED)!, WED);
check('지난 하루도 뽑힌다', pastReport.includes('이력서 정리'), true);

console.log('\n── 히스토리 ──');
const hist = buildHistory(user0, MON, WED);
check('요청한 날짜 수만큼', hist.length, 3);
check('월요일 완료 2건', hist.find((d) => d.date === MON)?.done, 2);
check('월요일 회고 제출됨', hist.find((d) => d.date === MON)?.submitted, true);
const histText = historyLines(hist).join('\n');
check('빈 날도 빠지지 않는다', historyLines(buildHistory(user0, '2026-09-12', '2026-09-13')).length, 2);
check('히스토리에 근무시간 표기', histText.includes('🏢'), true);

console.log('\n── 답변 파싱 ──');
const { splitItems } = await import('../src/domain/textItems.js');
check('쉼표는 자르지 않는다', splitItems('웹훅 ERD + PRD 작성, 영상님과 미팅 (~70%)'), [
  '웹훅 ERD + PRD 작성, 영상님과 미팅 (~70%)',
]);
check('줄바꿈 + 불릿', splitItems('- 이력서 마무리\n- 인강 3강'), ['이력서 마무리', '인강 3강']);
check('한 줄 안의 번호', splitItems('1. 이력서 마무리 2. 인강 3강'), ['이력서 마무리', '인강 3강']);
check('띄어쓴 슬래시', splitItems('기출 채점 / 오답 정리'), ['기출 채점', '오답 정리']);
check('세미콜론', splitItems('기출 5회분; 오답정리'), ['기출 5회분', '오답정리']);
check('가운뎃점', splitItems('인강 3강 • 오답 정리'), ['인강 3강', '오답 정리']);
check('체크 기호 제거', splitItems('✅ 완료한 일'), ['완료한 일']);
check('URL 은 안 쪼갠다', splitItems('https://a.com/b 확인'), ['https://a.com/b 확인']);
check('소수점은 번호가 아니다', splitItems('2.5시간 공부'), ['2.5시간 공부']);
check('"없음" 은 할 일이 아니다', splitItems('없음'), []);
check('빈 줄 무시', splitItems('a\n\n\nb'), ['a', 'b']);

console.log('\n── 근무시간 기본값 ──');
const { autoClose, setManualAttendance } = await import('../src/domain/attendance.js');
const FRI = '2026-09-11';
clockIn(USER, FRI, kst(FRI, '09:30')); // 퇴근을 안 찍음
const auto = autoClose(getAttendanceRow(USER, FRI)!, TZ);
check('퇴근 미기록 → 정규 퇴근 18:00 으로 마감', auto.worked_minutes, 420);
check('자동 마감 표시', auto.auto_closed, 1);
check('미출근일은 0시간', formatDuration(summarize(user0, '2026-09-13', '2026-09-13', WED).totalMinutes), '0시간');

const fixed = setManualAttendance(
  USER,
  FRI,
  kst(FRI, '10:00').toISOString(),
  kst(FRI, '19:00').toISOString(),
  TZ,
);
check('수정하면 9시간 - 점심 90분', fixed.worked_minutes, 450);
check('수정하면 자동 마감 해제', fixed.auto_closed, 0);
check('KST 09:30 은 UTC 00:30', kst(FRI, '09:30').toISOString(), '2026-09-11T00:30:00.000Z');

console.log('\n── 체크인 대화 ──');
const { startCheckinSession, openCheckinSession, getCheckinSession } = await import('../src/db/checkins.js');
const { checkinPrompt, checkinConfirm } = await import('../src/slack/blocks/checkin.js');

startCheckinSession(USER, WED, 'D_TEST');
check('체크인 세션이 열린다', openCheckinSession(USER)?.stage, 'ask');

// handleCheckinAnswer 의 저장 규칙을 그대로 따라 해 본다 (슬랙 호출 없이)
const { deleteTask: dropTask } = await import('../src/db/tasks.js');
for (const t of tasksForDay(USER, WED)) if (t.status === 'planned') dropTask(t.id);
addTask({ userId: USER, workday: WED, title: '이력서 다시 쓰기', milestoneId: ms.id, source: 'checkin' });
addTask({ userId: USER, workday: WED, title: '인강 3강', source: 'checkin' });
const savedTasks = tasksForDay(USER, WED).filter((t) => t.status !== 'done');
check('할 일 2개 저장', savedTasks.length, 2);

const promptText = JSON.stringify(
  checkinPrompt({ workday: WED, carryOver: [], milestones: [ms] }),
);
check('질문에 마일스톤 연결법 안내', promptText.includes('#번호'), true);
check('질문이 모달이 아니라 블록 배열', Array.isArray(checkinPrompt({ workday: WED, carryOver: [], milestones: [] })), true);

const confirmText = JSON.stringify(
  checkinConfirm({ workday: WED, tasks: savedTasks, milestoneNames: new Map([[ms.id, ms.title]]) }),
);
check('확인 메시지에 저장 내용이 그대로 보인다', confirmText.includes('이력서 다시 쓰기'), true);
check('확인 메시지에 마일스톤 이름', confirmText.includes('포트폴리오 공개'), true);

const { completeCheckinSession } = await import('../src/db/checkins.js');
completeCheckinSession(USER, WED);
check('답하면 세션이 닫힌다', getCheckinSession(USER, WED)?.stage, 'complete');
check('닫힌 뒤엔 열린 세션 없음', openCheckinSession(USER), undefined);

console.log('\n── 답변 수정 반영 ──');
const { findByAnswerTs, setBoardMessage } = await import('../src/db/standups.js');
const { findCheckinByAnswerTs } = await import('../src/db/checkins.js');
const { syncNextDayTasks } = await import('../src/service/standupFlow.js');

const EDIT_DAY = '2026-09-14'; // 월요일
saveAnswer(USER, EDIT_DAY, 'done_text', '처음 쓴 DONE', '1757000001.000100');
saveAnswer(USER, EDIT_DAY, 'next_text', '처음 쓴 NEXT', '1757000002.000200');
saveAnswer(USER, EDIT_DAY, 'note_to_self', '처음 쓴 한마디', '1757000003.000300');

check('ts 로 DONE 을 되찾는다', findByAnswerTs(USER, '1757000001.000100')?.field, 'done_text');
check('ts 로 NEXT 를 되찾는다', findByAnswerTs(USER, '1757000002.000200')?.field, 'next_text');
check('ts 로 한마디를 되찾는다', findByAnswerTs(USER, '1757000003.000300')?.field, 'note_to_self');
check('모르는 ts 는 못 찾는다', findByAnswerTs(USER, '9999.9999'), undefined);

// NEXT 를 고치면 저장값과 다음날 할 일이 둘 다 따라와야 한다
syncNextDayTasks(user0, EDIT_DAY, '처음 쓴 NEXT');
check('처음 NEXT 로 다음날 할 일 1개', tasksForDay(USER, '2026-09-15').length, 1);

saveAnswer(USER, EDIT_DAY, 'next_text', '고친 NEXT 첫째\n고친 NEXT 둘째', '1757000002.000200');
syncNextDayTasks(user0, EDIT_DAY, '고친 NEXT 첫째\n고친 NEXT 둘째');
check('수정본이 저장된다', getStandup(USER, EDIT_DAY)?.next_text, '고친 NEXT 첫째\n고친 NEXT 둘째');
check('다음날 할 일이 2개로 다시 만들어진다', tasksForDay(USER, '2026-09-15').length, 2);
check(
  '옛 NEXT 로 만든 할 일은 사라진다',
  tasksForDay(USER, '2026-09-15').some((t) => t.title === '처음 쓴 NEXT'),
  false,
);

setBoardMessage(USER, EDIT_DAY, 'C_BOARD', '1757000009.000900');
check('보드 위치가 기록된다', getStandup(USER, EDIT_DAY)?.board_ts, '1757000009.000900');

startCheckinSession(USER, EDIT_DAY, 'D_TEST');
completeCheckinSession(USER, EDIT_DAY, '1757000004.000400');
check('체크인 답변도 ts 로 찾는다', findCheckinByAnswerTs(USER, '1757000004.000400')?.workday, EDIT_DAY);

console.log('\n── 오후 중간 점검 ──');
const { applyProgressUpdate } = await import('../src/service/middayFlow.js');
const { startMiddaySession, openMiddaySession, completeMiddaySession } = await import('../src/db/middays.js');

const MID = '2026-09-16';
addTask({ userId: USER, workday: MID, title: '인강 3강', source: 'checkin' });
addTask({ userId: USER, workday: MID, title: '기출 2회분 채점', source: 'checkin' });
addTask({ userId: USER, workday: MID, title: '이력서 문장 다듬기', source: 'checkin' });

const r1 = applyProgressUpdate(user0, MID, '인강 3강');
check('정확히 같은 이름은 완료 처리', r1.completed, ['인강 3강']);
check('새로 추가된 것 없음', r1.added, []);

const r2 = applyProgressUpdate(user0, MID, '기출');
check('일부만 적어도 후보가 하나면 매칭', r2.completed, ['기출 2회분 채점']);

const r3 = applyProgressUpdate(user0, MID, '동네 도서관 등록');
check('계획에 없던 일은 새로 기록', r3.added, ['동네 도서관 등록']);
check('완료 4건 (계획 2 + 새 1 … 남은 계획 1)',
  tasksForDay(USER, MID).filter((t) => t.status === 'done').length, 3);

const r4 = applyProgressUpdate(user0, MID, '동네 도서관 등록');
check('같은 내용을 다시 반영해도 중복 안 쌓임', r4.added, []);
check('할 일 총 개수 그대로', tasksForDay(USER, MID).length, 4);

startMiddaySession(USER, MID, 'D_TEST');
check('중간 점검 세션이 열린다', openMiddaySession(USER)?.stage, 'ask');
completeMiddaySession(USER, MID);
check('닫으면 열린 세션 없음', openMiddaySession(USER), undefined);

console.log('\n── 할 일 체크 표시 ──');
const { taskChecklist } = await import('../src/slack/blocks/checkin.js');
const checkTasks = tasksForDay(USER, MON);
const rendered = JSON.stringify(taskChecklist(checkTasks, new Map()));
check('완료한 할 일은 체크 표시', rendered.includes('✅'), true);
check('안 끝난 할 일은 빈 네모', rendered.includes('⬜️'), true);
const allDone = checkTasks.map((t) => ({ ...t, status: 'done' as const }));
const doneOnly = JSON.stringify(taskChecklist(allDone, new Map()));
check('전부 완료면 빈 네모가 사라진다', doneOnly.includes('⬜️'), false);
check('오버플로 메뉴가 완료 취소로 바뀐다', doneOnly.includes('완료 취소'), true);

console.log('\n── 홈 탭 블록 ──');
const { homeView } = await import('../src/slack/blocks/home.js');
const { getStreak } = await import('../src/db/streaks.js');
const { getAttendance } = await import('../src/db/attendance.js');
createMilestone({ userId: USER, title: '두 번째 마일스톤' });
const view = homeView({
  user: user0,
  today: WED,
  tasks: tasksForDay(USER, MON),
  milestones: (await import('../src/db/milestones.js')).listMilestones(USER),
  streak: getStreak(USER),
  badge: '🔥',
  attendance: getAttendance(USER, WED),
  minutesToday: 510,
  weekMinutes: 690,
  standup: undefined,
});

// 슬랙은 한 뷰 안에서 action_id 가 겹치면 뷰 자체를 거부한다.
const ids: string[] = [];
for (const b of view as unknown as Record<string, any>[]) {
  if (b['accessory']?.action_id) ids.push(b['accessory'].action_id);
  for (const e of (b['elements'] ?? []) as Record<string, any>[]) {
    if (e['action_id']) ids.push(e['action_id']);
  }
}
check('action_id 중복 없음', ids.length - new Set(ids).size, 0);

const { morningMessage } = await import('../src/slack/blocks/standup.js');
const { listMilestones } = await import('../src/db/milestones.js');
const morning = morningMessage({
  name: '테스터',
  workday: TUE,
  yesterday: { date: MON, done: ['이력서 정리', '깃허브 정리'], note: '오늘 잘했다' },
  todayPlan: ['사이트 뼈대 잡기'],
  carryOver: tasksForDay(USER, MON).filter((t) => t.status === 'planned'),
  milestones: listMilestones(USER, 'active'),
  streak: 2,
  badge: '🔥',
  working: false,
});
const morningText = JSON.stringify(morning);
check('아침에 어제 한 일이 보인다', morningText.includes('이력서 정리'), true);
check('아침에 오늘 할 일이 보인다', morningText.includes('사이트 뼈대 잡기'), true);
check('아침에 나에게 한 말이 보인다', morningText.includes('오늘 잘했다'), true);
check('아침에 마일스톤이 보인다', morningText.includes('포트폴리오 공개'), true);
check('아침에 모닝 루틴이 보인다', morningText.includes('개인 캘린더에 입력'), true);
check('모닝 루틴은 기록이 없어도 나온다',
  JSON.stringify(morningMessage({
    name: '테스터', workday: TUE, yesterday: null, todayPlan: [], carryOver: [],
    milestones: [], streak: 0, badge: '·', working: false,
  })).includes('모닝 루틴'), true);

const morningIds = morning
  .flatMap((b) => ((b as Record<string, any>)['elements'] ?? []) as Record<string, any>[])
  .map((e) => e['action_id'])
  .filter(Boolean);
check('아침 메시지 action_id 중복 없음', morningIds.length - new Set(morningIds).size, 0);
check('미출근 시 버튼 2개', morningIds.length, 2);
check(
  '출근 중이면 출근 버튼 없음',
  morningMessage({
    name: '테스터', workday: TUE, yesterday: null, todayPlan: [], carryOver: [],
    milestones: [], streak: 0, badge: '·', working: true,
  })
    .flatMap((b) => ((b as Record<string, any>)['elements'] ?? []) as Record<string, any>[])
    .filter((e) => e['action_id']).length,
  1,
);

check('블록 수 50 이하', view.length <= 50, true);

console.log(`\n${failures === 0 ? '전부 통과' : `${failures}건 실패`}\n`);
process.exit(failures === 0 ? 0 : 1);

void addDays;
