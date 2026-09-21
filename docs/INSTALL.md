# JK 설치 가이드

JK의 기본 배포 방식은 **사용자 PC에서 직접 실행하는 로컬 런타임**입니다. 지인이 JK를 사용하기 위해 OCI, AWS, 개인 VPS 같은 상시 서버를 운영할 필요는 없습니다.

> 유지보수자는 원저자에게 이 수정 포크의 재배포 허가를 직접 받았습니다. 이 문서는 기술적인 설치/배포 절차를 설명하며 원본 코드를 별도 오픈소스 라이선스로 재허가하지 않습니다. 자세한 내용은 [Attribution & Compliance](ATTRIBUTION_AND_COMPLIANCE.md)를 확인하세요.

## 처음 설치: Windows 3단계

기본 권장 경로는 unsigned Windows 실행 파일이 아니라 **npm setup wizard**입니다.

### 1. Node.js 22+ 설치

Node.js 공식 설치 프로그램이나 Windows Package Manager를 사용합니다. Node.js가 준비되면 새 PowerShell 창을 엽니다.

### 2. 아래 한 줄 실행

```powershell
npx -y jk-mcp setup
```

설치 마법사가 다음을 순서대로 처리합니다.

- ChatGPT가 작업 가능한 폴더 선택 또는 직접 경로 입력
- 연결 방식 선택
  - **Quick Tunnel (추천):** 도메인 없이 바로 사용, 재시작 시 주소가 바뀔 수 있음
  - **고정 HTTPS 도메인:** 이미 Cloudflare Named Tunnel 또는 HTTPS reverse proxy를 구성한 사용자를 위한 선택지
- Node.js 버전과 Git / ripgrep / 필요한 경우 `cloudflared` 확인
- Windows에서 누락 도구가 있으면 공식 `winget` package ID를 보여주고 **설치 동의를 먼저 받음**
- 선택한 폴더에서 JK 프로젝트를 몇 개 찾았는지 안내
- 일반 폴더만 있고 프로젝트가 0개라면 `.git`, `package.json`, `.chatgpt2codex` 같은 프로젝트 표시 파일을 안내
- 최초 개인 연결 코드 생성
- 기존 코드가 있으면 **기존 코드 유지** 또는 **새 코드를 발급해 지금 화면에 표시** 중 선택
- 최종 ChatGPT Connector URL과 필요한 경우 새 개인 연결 코드 표시

### 3. ChatGPT에 마지막 주소 등록

setup 마지막 화면에 나온 `https://....trycloudflare.com/mcp` 주소를 ChatGPT **Apps / Connectors**의 Custom MCP 연결에 붙여넣습니다. 연결 과정에서 코드 입력을 요구하면 setup이 보여준 **개인 연결 코드**를 사용하세요.

이 코드는 내부적으로 Owner Token이며 비밀번호처럼 다뤄야 합니다. 메신저, Issue, 스크린샷, 로그에 공개하지 마세요. JK를 사용하는 동안에는 setup을 실행한 PowerShell 창을 열어 둡니다.

개인 도메인과 OCI/VPS는 기본 사용에 필요하지 않습니다. Quick Tunnel URL은 재시작 시 바뀔 수 있습니다.

고정 도메인을 선택할 경우 도메인 이름만 입력한다고 자동으로 연결되는 것은 아닙니다. 해당 HTTPS 주소가 **이미** 사용자 PC의 JK(`http://127.0.0.1:7979`)로 전달되도록 Cloudflare Named Tunnel이나 다른 HTTPS reverse proxy를 구성해 두어야 합니다. setup은 이 고정 주소를 저장해 다음 실행에서도 재사용합니다.

JK의 개인 연결 코드는 평문으로 저장되지 않고 해시만 저장됩니다. 따라서 기존 코드를 잃어버렸다면 같은 코드를 다시 표시할 수 없고, setup에서 새 코드를 발급해야 합니다.

## 다시 시작하기

초보자는 다음에도 **처음과 똑같은 명령 한 줄**만 실행하면 됩니다.

```powershell
npx -y jk-mcp setup
```

JK가 이전에 허용한 폴더와 연결 방식을 재사용합니다. Quick Tunnel 사용자는 새 임시 주소를 받고, 고정 도메인 사용자는 저장된 HTTPS 주소를 다시 사용할 수 있습니다. 기존 개인 연결 코드는 유지할 수 있고, 코드가 없으면 setup에서 새 코드를 발급해 한 번 표시할 수 있습니다. 전역 명령을 원하는 사용자는 `npm install -g jk-mcp` 후 `jk start --quick-tunnel`을 사용할 수 있습니다. 설정만 저장하고 서버를 시작하지 않는 `--no-start`도 지원합니다.

## 선택 사항: Windows GUI 패키지

GitHub Release의 Setup/Portable 패키지는 트레이 GUI가 필요한 사용자를 위한 보조 경로입니다. 코드 서명이 없는 빌드는 SmartScreen 경고가 발생할 수 있으므로 일반 배포에서는 npm setup wizard를 우선합니다.

## OCI 없이 어떻게 연결되나요?

기본 구조는 다음과 같습니다.

```text
ChatGPT 웹
  -> HTTPS Connector URL
  -> Cloudflare Quick Tunnel (기본 초보자 경로)
  -> 사용자 PC의 JK
  -> 선택한 로컬 프로젝트
```

따라서 다음은 필요하지 않습니다.

- Oracle Cloud VM
- AWS EC2
- 유지보수자의 개인 서버

다만 ChatGPT 웹은 사용자 PC의 `127.0.0.1`에 직접 접속할 수 없으므로 **웹에서 사용할 때는 인터넷에서 접근 가능한 HTTPS 경로**가 필요합니다.

npm 설치판은 `cloudflared` 바이너리를 번들하지 않습니다. `jk start --quick-tunnel`은 공식 경로로 별도 설치된 `cloudflared`를 호출해 임시 URL을 가져옵니다.

### Quick Tunnel의 특징

- 별도 클라우드 VM이나 개인 서버가 필요 없습니다.
- 별도 도메인이 없어도 시작할 수 있습니다.
- 앱/터널을 재시작하면 URL이 바뀔 수 있습니다.
- URL이 바뀌면 ChatGPT Connector도 새 URL로 갱신해야 합니다.

매일 고정 주소로 쓰고 싶다면 그때만 본인이 관리하는 Cloudflare Named Tunnel + 도메인 또는 다른 HTTPS reverse proxy를 사용하면 됩니다. 이것은 **선택 사항**입니다.

## 승인 시스템

JK는 선택한 프로젝트 안에서 동작하지만, 모든 작업을 무조건 자동 실행하지는 않습니다.

일반적으로 다음과 같은 민감 작업은 승인 게이트를 사용할 수 있습니다.

- 네트워크를 사용하는 명령
- 파괴적 파일/시스템 작업
- Git commit / push
- 런타임 교체 같은 고위험 작업

JK는 같은 bounded 작업의 미리 선언된 위험 명령을 approval bundle로 묶을 수 있고, 승인 후에는 새 명령을 반복 생성하는 대신 기존 `approvalId` / `jobId` 결과를 이어받는 구조를 사용합니다.

승인 요청의 범위를 확인한 뒤 허용하세요. 이미 승인한 범위가 나중에 몰래 넓어지도록 설계하지 않습니다.

## 처음 써볼 요청

```text
@jk 이 프로젝트를 선택하고 README와 package scripts를 확인한 뒤,
수정 없이 구조와 실행 방법만 설명해줘.
```

```text
@jk 이 버그 원인을 찾고 최소 수정한 다음 관련 테스트까지 돌려줘.
```

```text
@jk 현재 변경사항을 리뷰하고 테스트가 통과하면 커밋해줘.
```

## 로컬 주소

기본 로컬 런타임 포트는 `7979`입니다.

- Dashboard: `http://127.0.0.1:7979/`
- MCP: `http://127.0.0.1:7979/mcp`
- Health: `http://127.0.0.1:7979/healthz`

ChatGPT 웹에서는 localhost URL 자체가 아니라 앱이 제공하는 HTTPS Connector URL을 사용합니다.

## 문제 해결

### Connector URL이 비어 있음

- Settings에서 **ChatGPT web connector**가 켜져 있는지 확인합니다.
- **Start MCP**를 누릅니다.
- 잠시 후 **Copy Connector URL**을 다시 확인합니다.

### ChatGPT가 연결되지 않음

- URL이 `/mcp`로 끝나는지 확인합니다.
- Quick Tunnel을 재시작했다면 URL이 바뀌었는지 확인합니다.
- JK 트레이에서 MCP를 Restart한 뒤 다시 시도합니다.

### 포트 7979가 사용 중

JK 트레이에서 **Restart MCP**를 먼저 사용하세요. 개발 환경에서는 오래된 JK/node 프로세스가 남아 있는지도 확인합니다.

### SmartScreen 경고

기본 npm 설치 경로는 별도 JK 설치 EXE를 실행하지 않습니다. 선택적으로 Windows GUI 패키지를 사용할 경우 코드 서명이 없는 개발 빌드에는 SmartScreen 경고가 나타날 수 있습니다.

### E2E 스크린샷이 안 나옴

Windows 웹 E2E는 설치된 Microsoft Edge 또는 Google Chrome을 사용합니다. 브라우저가 설치되어 있는지 확인하세요.

## 업데이트

npm 사용자는 다음 명령으로 업데이트합니다.

```bash
npm install -g jk-mcp@latest
```

GUI Setup/Portable 사용자는 기존 Release 업데이트 방식을 계속 사용할 수 있습니다.

## 개발자: 소스에서 실행

소스 기준 요구사항:

- Node.js 22 이상
- npm
- Windows에서는 PowerShell

```bash
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run typecheck
npm test
npm run build
```

Windows 실행:

```powershell
npm run chatgpt:windows
```

Windows 패키지 빌드:

```powershell
npm run windows:package
```

Portable 앱 폴더만 만들려면:

```powershell
npm run windows:portable
```

릴리스 태그(`v*`)를 push하거나 Windows Release workflow를 수동 실행하면 GitHub Actions가 Windows installer와 Portable ZIP을 Release에 게시하도록 구성되어 있습니다.

## Remote executor는 언제 필요한가요?

일반 사용자에게는 필요 없습니다.

별도 머신이나 상시 runtime은 다음과 같은 고급 운영 상황에서만 고려하면 됩니다.

- PC가 꺼져 있어도 항상 같은 endpoint를 유지하고 싶을 때
- 여러 머신을 remote executor로 묶을 때
- 개인 도메인과 상시 tunnel을 직접 운영할 때

이 경우에도 개인 인프라 설정은 공개 기본 설치 흐름과 분리하는 것을 권장합니다. 호스트별 확장은 [LOCAL_OVERRIDES.md](LOCAL_OVERRIDES.md)를 사용하세요. 특정 클라우드 제공자용 프로비저닝과 자동 배포는 공개판 기본 기능이 아닙니다.

---

# English quick install

For normal users, **no cloud server is required**. Install Node.js 22+ and the normal Git/ripgrep prerequisites, then run `npm install -g jk-mcp`.

Run `jk setup --workspace /path/to/projects`, then `jk start --workspace /path/to/projects --quick-tunnel`. The Quick Tunnel mode uses an separately installed official `cloudflared` binary and prints the `/mcp` Connector URL. Add that URL in ChatGPT **Apps / Connectors** and use the local Owner Token when approval is requested.

The default local port is `7979`. Quick Tunnel URLs can change after restart; a personal domain or Named Tunnel is optional and only needed for a stable URL.

The legacy Windows GUI packages remain optional. Source builds require Node.js 22+ and npm.
