# AI Desk Pet — 통합 데스크탑 AI 모니터 위젯

회사·종류를 가리지 않고 로컬에서 구동 중인 AI 작업 상태(**지금 하는 작업 / 잔여 사용량 / 완료·승인대기·보류·오류**)를 데스크탑에 항상 띄워 두고 한눈에 확인하는 무설치(Zero-Install) 위젯입니다.

- **배포용 압축 파일(`dist/`)**:
  - `dist/AI-Desk-Pet-Windows.zip` (Windows 10/11용)
  - `dist/AI-Desk-Pet-Mac.zip` (macOS용, 안내서 `README_Mac.md` 포함)

---

## 1. 실행 방법 (Windows)

1. **데스크탑 위젯 (추천):** `01_AI_데스크펫_실행.cmd` 더블클릭
   - 콘솔 창 없이 바탕화면 우측 하단에 **미니 펫 + 상태 배지(`현재 작업 중 N개` 등)**가 뜹니다.
   - **왼쪽 클릭**: 대시보드 펼치기 / 접기
   - **드래그**: 원하는 위치로 이동 (위치 자동 저장)
   - **우클릭** 또는 **트레이 아이콘 메뉴**: 새로고침, 항상 위(Topmost) 전환, 알림 토스트 음소거, 위치 초기화, 종료
2. **가벼운 CMD 터미널 모니터:** `02_터미널_모니터_실행.cmd` 더블클릭
   - 5초 간격으로 모든 AI 작업과 잔여 사용량을 콘솔 창에 출력합니다.

---

## 2. 펫 상태 표시 기준

| 상태 | 색상 / 뱃지 | 의미 |
| --- | --- | --- |
| **승인 대기** (`approval`) | 노랑 `!` (강조 흔들림 + 알림) | 사용자 승인/응답/피드백 입력이 필요한 상태 |
| **오류** (`error`) | 빨강 `×` (`X X` 표정 + 알림) | 도구 실행 오류, 한도 초과, 비정상 종료 발생 |
| **작업 중** (`running`) | 초록 `●` (활기찬 바운스) | 현재 백그라운드/프론트에서 추론·명령 실행 진행 중 |
| **보류** (`paused`) | 파랑 `⏸` | 모델 용량 대기(`at capacity` 재시도 카운트다운) 또는 유휴 보류 |
| **완료** (`done`) | 연두 `✓` (`^ ^` 표정) | 최근 10분 이내 작업 완료 |
| **휴식 중** (`idle`) | 회색 `z` (`- -` 표정) | 활성 작업 없음 |

---

## 3. 프로바이더별 데이터 수집 방식 (토큰 소모 없음)

- **OpenAI Codex (앱 / CLI / 서브에이전트 / `/goal`)**
  - `~/.codex/state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, 세션 `rollout` JSONL
  - `rate_limits` 기반 잔여량(%) 및 초기화 예정 시각 표시
- **Anthropic Claude (데스크탑 / Cowork VM / Code 탭 / CLI)**
  - `AppData\Local\Claude-Data\...`, `logs\main.log`, `coworkd.log`, `plan-usage-history.json`, `~/.claude/`
  - 5시간 / 7일 캐시 잔여량(%) 표시
- **Google Antigravity (앱 / `agy` CLI)**
  - `~/.gemini/antigravity/conversation_summaries.db`, `brain/*/transcript.jsonl`
  - 로컬 잔여 % 캐시 파일이 제공되지 않으므로 **오늘 누적 토큰 수**와 단계 상태를 표시
- **기타 AI / 외부 연동 (Cursor, Ollama, LM Studio, Windsurf, Gemini CLI, Aider 등)**
  - 실행 중인 AI 프로세스 자동 감지
  - `%USERPROFILE%\.ai-desk-pet\external\*.json` 경로에 아래 형식의 JSON 파일을 쓰면 어떤 AI·스크립트든 위젯에 즉시 통합 표시됩니다.

```json
{
  "provider": "my-agent",
  "providerName": "사내 자동화 봇",
  "shortName": "Bot",
  "color": "#A855F7",
  "title": "자료 정리 배치",
  "status": "approval",
  "statusDetail": "승인 대기",
  "summary": "최종 내보내기 확인 필요",
  "remainingPct": 80,
  "quotaLabel": "일일 잔여",
  "model": "custom-model"
}
```
