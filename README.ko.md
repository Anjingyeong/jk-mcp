<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**ChatGPT에게 로컬 코딩 손을 달아주는 앱. 작업을 기억하고, 안전하게 실행하고, 결과를 증거로 남깁니다.**

[English](README.md) | [한국어](README.ko.md)

JK는 **Anjingyeong**이 설계하고 만든 무료 로컬 MCP 코딩 앱입니다. 설치하고 프로젝트 폴더를 고른 뒤 ChatGPT에 연결하면, 지금 대화에서 바로 코드 탐색, 파일 수정, 테스트, Git, E2E 검증을 하고 실행 결과를 증거로 받아볼 수 있습니다.

JK는 별도의 AI 모델이 아닙니다. 생각은 ChatGPT가 하고, JK는 작업 상태를 기억하고 안전장치를 지키는 로컬 실행 계층입니다.

> JK는 OpenAI와 제휴·후원·승인 관계가 없는 독립 프로젝트입니다. OpenAI, ChatGPT, GPT, Codex는 OpenAI의 상표 또는 제품입니다.

## 다운로드

[Releases 페이지](https://github.com/Anjingyeong/jk-mcp/releases)에서 앱을 받으세요. Node.js나 터미널은 필요 없습니다. Node.js, cloudflared, ripgrep이 앱에 들어 있습니다.

| OS | 파일 |
|---|---|
| Windows | `JK-...-setup.exe` |
| macOS | `jk-....pkg` |

아직 코드 서명이 되어 있지 않습니다. Windows SmartScreen이 뜨면 공식 Releases 페이지에서 받은 파일일 때만 **추가 정보 → 실행**을 누르세요.

### 터미널이 편하다면

Node.js 22+가 있으면 명령 하나로 설정이 끝나고, 커넥터 URL·Control Center·헬스체크 링크가 출력됩니다(Ctrl+클릭으로 열기).

```bash
npx -y jk-mcp setup
```

다음에도 같은 명령을 실행하면 됩니다. 저장된 폴더와 연결 코드를 그대로 씁니다. `npm install -g jk-mcp` 후에는 `jk start`로도 켤 수 있습니다.

## 빠른 시작

1. **JK**를 설치하고 실행합니다. 시계 옆 트레이(macOS는 메뉴 막대)에 아이콘이 생깁니다.
2. **설정...**을 열고 **프로젝트 폴더**에서 ChatGPT가 작업할 폴더를 고릅니다.
3. **토큰 자동 생성**을 누른 뒤 **소유자 토큰 복사**로 복사합니다. 비밀번호처럼 보관하세요.
4. **ChatGPT 웹 커넥터 사용**을 켜고 **MCP 시작**을 누릅니다.
5. **커넥터 URL 복사**를 누릅니다. 주소는 `/mcp`로 끝납니다.
6. ChatGPT의 **Apps & Connectors / Connectors**에서 새 커넥터를 만들고 URL을 붙여넣습니다.
7. JK 로그인 창이 뜨면 복사한 소유자 토큰(Owner Token)을 붙여넣습니다.
8. 확인용으로 이렇게 요청해 보세요: `@jk 이 프로젝트 README 읽고 현재 상태 요약해줘.`

### Connector URL: 임시 주소 vs 내 도메인

| | 도메인 없음 (기본) | 내 도메인 있음 (선택) |
|---|---|---|
| 주소 | `https://<랜덤>.trycloudflare.com/mcp` | `https://mcp.example.com/mcp` |
| 준비 | 없음. JK가 Cloudflare Quick Tunnel을 자동으로 만듭니다. | Cloudflare Named Tunnel이나 HTTPS 리버스 프록시를 `http://127.0.0.1:7979`로 연결하고, 그 호스트명을 **본인 소유 고정 도메인 (선택)**에 넣습니다. |
| JK 재시작 후 | **주소가 바뀝니다.** ChatGPT 커넥터 URL을 새 주소로 바꾸고 다시 로그인해야 합니다. | 주소가 그대로입니다. |
| 추천 용도 | 체험, 짧은 사용 | 매일 사용 |

도메인은 있으면 편하지만 필수는 아닙니다. 자세한 설정은 [설치 가이드](docs/INSTALL.md)를 참고하세요.

## 이렇게 요청하면 됩니다

```text
@jk 이 프로젝트 구조 뜯어서 설명해줘. 수정은 하지 마.
@jk 이 버그 원인 찾아서 고치고 관련 테스트까지 해줘.
@jk 아까 하던 작업 이어서 마무리해줘.
@jk 별도 작업 워크스페이스에서 구현하고 검증 후 원본에 반영해줘.
@jk E2E 테스트하고 통과 근거까지 보여줘.
@jk 현재 diff 리뷰하고 검증 통과하면 커밋해줘.
```

## 기능

- **지속 작업 세션**: 현재 목표, 작업 파일, 남은 일, 결정 사항, 체크포인트, 검증 결과를 저장해서 후속 요청이 처음부터 다시 시작하지 않고 실제 작업을 이어갑니다.
- **보호된 수정**: 기존 파일 수정에 SHA-256 precondition을 쓸 수 있습니다. 읽은 뒤에 파일이 바뀌었으면 수정을 거부합니다.
- **JK 오케스트레이션**: `goal_intake`와 `goal_loop`가 Explorer, Oracle, Implementer, Reviewer, Verifier, Recovery 역할로 긴 코딩 작업을 조율합니다. 검증에 실패하면 같은 방법을 반복하지 않고 계획을 다시 세웁니다.
- **MASS ULW**: 한 ChatGPT 대화 안에서 의존성을 고려해 구현·검증·수정·리뷰 lane을 돌립니다. [MASS ULW 워크플로우](docs/MASS_ULW_WEB.ko.md) 참고.
- **작업 워크스페이스**: 별도 워크스페이스에서 구현과 검증을 하고, 충돌 검사를 거쳐 통과한 변경만 원본에 반영합니다. [Task Workspaces](docs/TASK_WORKSPACES.ko.md) 참고.
- **로컬 실행 브리지**: 프로젝트 선택, 코드 검색, 좁은 범위 읽기, 보호된 패치, 허용된 명령과 shell job, Git status/diff/commit/명시적 push, 개발 서버, E2E와 스크린샷, 이미지 intake, 외부 MCP 라우팅, 런타임 상태 점검.
- **Control Center**: 작업 상태, 승인, 실행 기록, executor 정보, 런타임을 보는 로컬 대시보드.
- **OMO 위임 (선택)**: 로컬에 OMO / Oh My OpenAgent가 있으면 일부 작업을 넘길 수 있습니다. 상태·안전·검증 기준은 JK가 유지합니다.

## 안전 모델

JK는 신뢰할 수 있는 개발 환경에서 쓰는 것을 전제로 합니다.

- 선택한 프로젝트 폴더 안에서만 접근합니다.
- 민감한 shell, 네트워크, Git 공개, 삭제성 작업은 승인이 필요합니다.
- 비밀값처럼 보이는 내용은 도구 출력에서 가립니다.
- project lease와 작업 소유권으로 동시 수정 충돌을 막습니다.
- Owner Token 인증이 없는 MCP 요청은 거부합니다.

Owner Token, 터널 자격증명, 도메인 자격증명은 스크린샷, 로그, issue, 채팅에 절대 올리지 마세요. 유출되면 **설정**에서 새로 발급하세요.

## 개발자용: 소스에서 빌드

필요한 것: Node.js 22+, npm, Windows에서는 PowerShell.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

소스에서 실행:

```powershell
npm run chatgpt:windows   # Windows
```

```bash
npm run chatgpt           # macOS
npm run chatgpt:linux     # Linux
```

패키징과 E2E:

```powershell
npm run windows:package
npm run windows:e2e
```

<details>
<summary>저장소 구조</summary>

```text
src/
  auth/           인증 / Owner Token
  code/           검색, 읽기, 패치
  control/        제어 안전 경로
  control-center/ 로컬 운영 UI
  e2e/            브라우저 E2E / 증거
  exec/           command, shell, OMO runner
  executors/      로컬/원격 실행 라우팅
  orchestration/  MASS ULW / 장기 작업 로직
  policy/         승인, 경로, 비밀값, shell job 정책
  roles/          JK 오케스트레이션 역할
  server/         MCP tools / Actions bridge
  state/          지속 프로젝트/작업 세션 상태
  workspace/      프로젝트 registry / lease

windows/          Windows launcher / tray / installer
macos/            macOS 실행 경로
linux/            Linux 실행/설치 경로
scripts/          build / package / release / 검증
docs/             사용법 / 설계 / 엔지니어링 문서
assets/           JK 공개 리소스
```

</details>

## 만든 사람

JK는 **Anjingyeong**이 설계하고 만들고 유지보수합니다.

초기 코드베이스에는 원저작자의 허락을 받아 다른 프로젝트의 코드가 포함되었습니다. [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)와 [Attribution and compliance notes](docs/ATTRIBUTION_AND_COMPLIANCE.md)를 참고하세요.
