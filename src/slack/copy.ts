/**
 * 봇이 사람에게 하는 말은 전부 여기 모아 둔다.
 * 말투를 바꾸고 싶으면 이 파일만 고치면 된다 — 로직을 건드릴 일이 없다.
 */

export const COPY = {
  standup: {
    greeting: (name: string) =>
      `안녕하세요, ${name}님!\n:sunny: Daily Retro & Planning 시간이에요. 준비가 되시면 아래 질문에 대해 작성해 주세요.`,

    q1: `:one:  '오늘' 어떤 작업을 하셨나요? (진행중-대략적%, 완료, 리뷰중)`,
    q1PreviousHeader: `In your previous report, you mentioned:`,

    q2: `:two:  '내일' 어떤 작업을 계획하고 계신가요?`,

    q3: `:three:  오늘 하루도 고생한 나에게 해주고 싶은 말은?`,

    thanks: `:tada: Daily Retro/Planning 응답이 완료되었습니다!

여러분의 업데이트는 팀에게 큰 도움이 됩니다.
좋은 방향을 향해 가고 있다는 것이 느껴지네요 :raised_hands:

수고많으셨습니다! :muscle:`,

    alreadyDone: (workday: string) =>
      `${workday} 보고는 이미 마쳤습니다. 다시 쓰시려면 \`/standup 다시\` 를 입력하세요.`,

    nudge: `아직 오늘 마무리가 안 됐어요. 한 줄만 적어도 오늘은 기록된 하루가 됩니다.`,

    restarted: `처음부터 다시 시작할게요.`,
  },

  morning: {
    greeting: (name: string) => `좋은 아침입니다, ${name}님!`,

    /**
     * 모닝 루틴 리마인드 — 이 봇이 아침에 하는 "알람" 역할.
     * 요청자가 원한 것은 DM 내용을 취합해 주는 것이 아니라,
     * 출근하면 무엇부터 하는지 상기시켜 주는 것이다.
     * 항목을 바꾸려면 이 배열만 고치면 된다.
     */
    routineHeader: `:sunrise: 오늘의 모닝 루틴`,
    routine: [
      'DM 에 아카이빙해 둔 자료 확인하기',
      '오늘 할 일 정하기',
      '`/출근` 찍고 시작하기',
    ] as readonly string[],
    /** 어제 봇 DM 에 쌓인 기록을 아침에 되짚어 준다 — 이게 "아카이브 확인" 이다 */
    doneHeader: (day: string) => `${day} 에 하신 일`,
    plannedHeader: `하기로 하신 일`,
    carryHeader: `아직 안 끝난 할 일`,
    milestoneHeader: `마일스톤`,
    noPlan: `어제 남겨 둔 계획이 없습니다. 오늘 할 일을 새로 정해 볼까요?`,
    noRecord: `어제 남긴 기록이 없습니다.`,
  },

  attendance: {
    clockedIn: (time: string) => `:office: *출근* ${time}. 오늘도 시작합니다.`,
    alreadyIn: (time: string) => `이미 ${time}에 출근하셨어요.`,
    resumed: (time: string) => `퇴근 기록을 취소했습니다. ${time} 출근 상태로 이어갑니다.`,
    clockedOut: (time: string, worked: string, brk: number) =>
      `:door: *퇴근* ${time}. 오늘 근무 *${worked}*${brk > 0 ? ` (휴게 ${brk}분 제외)` : ''}.`,
    noClockIn: `출근 기록이 없어요. \`/출근\` 부터 찍어 주세요.`,
    autoClosed: (workday: string, worked: string) =>
      `${workday} 퇴근 기록이 없어 기본값 *${worked}* 으로 넣었습니다.\n` +
      `실제와 다르면 \`/근무 수정 ${workday} 09:00 18:00\` 처럼 고쳐 주세요.`,
  },

  help: `*이 봇이 하는 일*
매일 정해진 시간에 묻고, 답을 쌓아서 보고서와 진행도로 돌려줍니다.

*하루 흐름*
• 아침 — 어제 남긴 기록(한 일·할 일·마일스톤)을 되짚어 드립니다
• \`/출근\` — 근무 시작
• 저녁 — done-next 3가지 질문을 순서대로 여쭙니다
• \`/퇴근\` — 근무 종료, 근무시간 자동 계산

*명령어*
\`/출근\` \`/퇴근\` 근무 시작·종료 (\`/in\` \`/out\` 도 됩니다)
\`/근무\` 오늘·이번주·이번달 근무시간 (\`/근무 수정 09:30 18:00\` 으로 정정)
\`/standup\` done-next 지금 시작 (\`/standup 다시\` 로 재작성)
\`/checkin\` 오늘 할 일 정하기
\`/done <내용>\` 방금 끝낸 일 기록
\`/plan\` 오늘 할 일 보기
\`/milestone\` 마일스톤 만들기·진행도
\`/report [today|week|month]\` 업무보고 생성
\`/streak\` 연속 기록
\`/pause <일수>\` 휴가 (연속 기록 안 끊김)
\`/settings\` 시간·타임존·공유 채널 설정`,
} as const;
