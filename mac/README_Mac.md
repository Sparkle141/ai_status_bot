# AI Desk Pet (macOS 버전)

회사·종류를 가리지 않고 Mac에서 구동 중인 AI 작업 상태(**지금 하는 작업 / 잔여 사용량 / 완료·승인대기·보류·오류**)를 바탕화면에 항상 띄워 두고 한눈에 확인하는 무설치 macOS 위젯입니다.

---

## 1. 실행 방법 (Mac)

1. 압축을 푼 폴더에서 **`01_AI_데스크펫_실행.command`** 를 더블클릭합니다.
   - 바탕화면 우측 하단에 **미니 펫 + 상태 배지(`현재 작업 중 N개` 등)**가 뜹니다.
   - 상단 메뉴바에도 **`🤖 AI`** 아이콘이 추가됩니다.
   - **왼쪽 클릭**: 대시보드 펼치기 / 접기
   - **드래그**: 원하는 위치로 이동
   - **우클릭** 또는 **메뉴바 아이콘**: 새로고침, 항상 위(Topmost) 전환, 알림 음소거, 위치 초기화, 종료
2. **가벼운 터미널 모니터:** `02_터미널_모니터_실행.command` 더블클릭
3. **브라우저 창으로 보기:** `03_브라우저_모니터_열기.command` 더블클릭

> **처음 실행 시 "확인되지 않은 개발자" 또는 권한 오류가 뜨는 경우:**
> 압축 파일 전달 경로에 따라 macOS 격리 속성이 붙을 수 있습니다. 해당 폴더에서 터미널을 열고 아래 명령을 한 번만 실행해 주세요.
> ```bash
> xattr -cr . && chmod +x *.command widget-mac/*.sh
> ```

---

## 2. 펫 상태 표시 기준

| 상태 | 색상 / 뱃지 | 의미 |
| --- | --- | --- |
| **승인 대기** (`approval`) | 노랑 `!` (강조 흔들림 + 알림) | 사용자 승인/응답/피드백 입력이 필요한 상태 |
| **오류** (`error`) | 빨강 `×` (`X X` 표정 + 알림) | 도구 실행 오류, 한도 초과, 비정상 종료 발생 |
| **작업 중** (`running`) | 초록 `●` (활기찬 바운스) | 현재 추론·명령 실행 진행 중 |
| **보류** (`paused`) | 파랑 `⏸` | 모델 용량 대기(`at capacity`) 또는 유휴 보류 |
| **완료** (`done`) | 연두 `✓` (`^ ^` 표정) | 최근 10분 이내 작업 완료 |
| **휴식 중** (`idle`) | 회색 `z` (`- -` 표정) | 활성 작업 없음 |

---

## 3. 프로바이더별 데이터 수집 경로 (토큰 소모 없음)

- **OpenAI Codex**: `~/.codex/` (`state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `sessions/`)
- **Anthropic Claude**: `~/Library/Application Support/Claude/`, `~/Library/Logs/Claude/`, `~/.claude/`
- **Google Antigravity**: `~/.gemini/antigravity/` (`conversation_summaries.db`, `brain/*/transcript.jsonl`)
- **기타 AI / 외부 연동**: 실행 중인 프로세스(`Cursor`, `Ollama`, `LM Studio`, `Windsurf`, `Gemini CLI`, `Aider`, `OpenCode`) 자동 감지 + `~/.ai-desk-pet/external/*.json` 파일 연동
