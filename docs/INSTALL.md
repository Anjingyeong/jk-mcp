# JK 설치 가이드

JK 공개 배포판은 **로컬 MCP 하네스**입니다. Node.js 22+와 npm만 있으면 Windows, macOS, Linux에서 소스 기준으로 실행할 수 있습니다.

## 1. 설치

- macOS: `jk-<version>.pkg`
- Windows: `JK-Setup.exe`

Only download installers from the official GitHub release page. Keep the Owner
Token private; treat it like a password.

## Korean

### 이 앱은 무엇인가요?

JK는 내 Mac 또는 Windows PC에서 실행되는 로컬 코딩 연결 앱입니다. ChatGPT가 내 전체 컴퓨터를 가져가는 것이 아니라, 내가 선택한 프로젝트 폴더 안에서만 파일 읽기, 코드 수정, 테스트 실행, E2E 스크린샷 캡처 같은 작업을 하게 해줍니다.

### PKG가 DMG보다 나은가요?

이번 릴리스는 PKG가 낫습니다. DMG는 드래그 앤 드롭 앱에는 예쁘지만, 이 앱은 Applications에 메뉴 막대 앱을 설치하고, 번들 런타임을 넣고, 설치 후 Doctor 점검을 돌리는 흐름이 필요합니다. 초보자에게는 PKG가 더 덜 헷갈립니다.

### macOS 설치

1. 릴리스 페이지에서 `jk-<version>.pkg`를 다운로드합니다.
2. Finder에서 `.pkg` 파일을 엽니다.
3. macOS가 "확인할 수 없는 개발자" 또는 "악성 소프트웨어를 확인할 수 없음"이라고 막으면:
   - 파일을 Control-클릭 또는 오른쪽 클릭합니다.
   - **열기**를 누릅니다.
   - 그래도 막히면 **시스템 설정** -> **개인정보 보호 및 보안**에서 **그래도 열기**를 누릅니다.
4. 설치가 끝나면 **응용 프로그램**에서 **JK**를 실행합니다.
5. 화면 위 메뉴 막대에 아이콘이 보이면 실행된 것입니다.

### Windows 설치

1. 릴리스 페이지에서 `JK-Setup.exe`를 다운로드합니다.
2. 파일을 더블클릭합니다.
3. Windows SmartScreen이 경고하면 **추가 정보** -> **실행**을 누릅니다. 단, 반드시 이 GitHub 릴리스에서 받은 파일일 때만 진행하세요.
4. 설치가 끝나면 **JK**를 실행합니다.
5. 오른쪽 아래 시스템 트레이에 아이콘이 보이면 실행된 것입니다.
6. 설치 중 Node.js LTS 또는 cloudflared가 없으면 앱이 설치를 안내할 수 있습니다.

### 첫 설정

1. macOS는 메뉴 막대 아이콘, Windows는 시스템 트레이 아이콘을 누릅니다.
2. **Settings...**를 엽니다.
3. **Project folder**에서 ChatGPT가 도와줄 프로젝트 폴더를 고릅니다.
4. ChatGPT 웹에서 연결하려면 **ChatGPT web connector**를 켭니다.
5. 고정 도메인이 없다면 도메인 칸은 비워둡니다. 그러면 임시 `trycloudflare.com` 주소가 만들어질 수 있습니다.
6. **Start MCP**를 누릅니다.
7. 상태가 켜질 때까지 기다립니다.
8. **Copy Connector URL**을 누릅니다. 주소는 `/mcp`로 끝나야 합니다.
9. ChatGPT의 Apps, Apps & Connectors, 또는 Connectors 설정에서 새 앱/커넥터를 만듭니다.
10. 복사한 `/mcp` 주소를 붙여넣습니다.
11. 승인 화면이 나오면 JK 앱에서 Owner Token을 복사해 입력합니다.

### Standalone / Office 모드 (상시 켜진 PC)

새 설치의 기본 프로필은 **Standalone / Office**입니다. 회사 PC처럼 머신을 계속 켜 둘 수 있다면 OCI가 필요하지 않습니다. 이 PC가 MCP 서버, Control Center, 승인 상태를 직접 소유합니다.

1. **Settings...**에서 **Standalone / Office**가 켜져 있는지 확인합니다.
2. **Project folder**에서 이 PC에서 작업할 폴더를 고릅니다.
3. 외부 ChatGPT 연결이 필요하면 web connector/public tunnel을 켭니다.
4. 직접 관리하는 고정 호스트가 있다면 예를 들어 `mcp.company.example`을 입력하고, 외부에서 관리하는 Cloudflare Named Tunnel 등의 origin을 `http://127.0.0.1:7979`로 연결합니다.
5. ChatGPT에는 `https://mcp.company.example/mcp`를 등록합니다.

Office 모드는 실행 시 남아 있을 수 있는 `JK_HUB_URL`/executor-only 환경을 격리하므로, 예전 하이브리드 설정이 새 회사 PC의 로컬 MCP를 가로채지 않습니다. PC가 꺼지면 해당 MCP 주소도 오프라인이 되는 것이 정상입니다.

OCI 또는 별도 hub + remote executor 구성이 필요한 경우에만 **Standalone / Office**를 끄고 Advanced 토폴로지를 사용하세요. 승인 최소화는 Office/Advanced 모두 같은 JK 코어 정책을 사용하며, 임의 삭제·reset/force·새 destructive 작업의 승인 경계는 그대로 유지됩니다.

### E2E 스크린샷 사용

ChatGPT에 이렇게 말할 수 있습니다.

```text
JK로 앱을 실행하고 E2E 테스트를 돌린 뒤 스크린샷을 캡처해서 보여줘.
```

## 2. 실행

Linux/macOS:

On Linux, a fresh install uses the canonical `jk` prefix and `jk.service`. If the installer detects an existing `chatgpt2codex` installation, it preserves that installation's legacy prefix and service name during upgrade; this is compatibility behavior, not the fresh-install default. The canonical `jk` command remains the primary interface, with no arbitrary legacy-alias expiration.

막히면 **System Settings** -> **Privacy & Security**에서 JK 권한을 켜고 다시 실행하세요.

Windows에서는 브라우저 또는 앱 창 캡처 권한 경고가 뜨면 허용하세요. 캡처가 비어 있으면 앱을 관리자 권한 없이 일반 실행으로 다시 켜고, 캡처 대상 창이 실제 화면에 보이는지 확인하세요.

### 주의

- Owner Token은 비밀번호처럼 다루세요.
- 임시 `trycloudflare.com` 주소는 앱이나 터널을 재시작하면 바뀔 수 있습니다.
- Windows SmartScreen 경고는 아직 널리 알려지지 않은 새 설치파일에서 보일 수 있습니다. 공식 릴리스 파일인지 확인한 뒤 진행하세요.

## English

### What is it?

JK is a local macOS and Windows app that lets ChatGPT work inside a project folder you choose. It can read files, apply patches, run checks, launch E2E flows, and send screenshot proof back to the chat.

### Why PKG instead of DMG?

PKG is better for this release. A DMG is great for drag-and-drop apps, but this app installs a menu bar runtime into Applications, bundles helper binaries, and runs a post-install Doctor. PKG gives beginners the clearest install path.

### Install on macOS

1. Download `jk-<version>.pkg` from the release page.
2. Open the package in Finder.
3. If macOS blocks it because it is unsigned, Control-click the file, choose **Open**, then confirm. If needed, open **System Settings** -> **Privacy & Security** -> **Open Anyway**.
4. Open **JK** from **Applications**.
5. Click the menu bar icon to confirm it is running.

### Install on Windows

1. Download `JK-Setup.exe` from the release page.
2. Double-click the installer.
3. If Windows SmartScreen appears, choose **More info** -> **Run anyway** only if the file came from this GitHub release.
4. Open **JK**.
5. Confirm the tray icon appears near the clock.
6. If Node.js LTS or cloudflared is missing, follow the app's setup prompt.

### First setup

1. Open **Settings...** from the macOS menu bar icon or Windows tray icon.
2. Choose your **Project folder**.
3. Enable **ChatGPT web connector** if ChatGPT in the browser needs to reach this computer.
4. Click **Start MCP**.
5. Click **Copy Connector URL**. It should end with `/mcp`.
6. Add that URL in ChatGPT under Apps, Apps & Connectors, or Connectors.
7. Approve the connection with the Owner Token from the app.

### Standalone / Office mode (always-on PC)

Fresh installs default to **Standalone / Office**. If a company workstation stays online, no OCI hop is required: that machine owns the MCP server, Control Center, and approval state directly.

Choose the project folder, enable the web connector/public tunnel when needed, and optionally point a user-managed hostname such as `mcp.company.example` at `http://127.0.0.1:7979`. Register `https://mcp.company.example/mcp` in ChatGPT. Office mode removes inherited remote-executor variables from the child JK process so an old hub configuration cannot accidentally take over the local MCP runtime.

Turn Office mode off only when you intentionally use an Advanced hub + remote-executor topology. JK's bounded approval reuse applies in both profiles; arbitrary destructive work still requires its normal explicit approval boundary.

### E2E screenshots

Try:

```text
Use JK to run E2E, open the app, capture screenshots, and show them inline.
```

Windows PowerShell:

```powershell
npm run chatgpt:windows
```

직접 실행하려면 다음도 가능합니다.

```bash
node dist/cli.js init --workspace ~/workspace
node dist/cli.js serve --http --port 7979 --public-url http://127.0.0.1:7979 --workspace ~/workspace
```

기본 Dashboard와 MCP endpoint는 로컬 `127.0.0.1:7979`에서 동작합니다.

## 3. ChatGPT에서 사용

JK는 MCP 서버 자체를 제공합니다. 외부 ChatGPT 클라이언트가 로컬 머신에 직접 접근할 수 없는 환경이라면 **사용자가 별도로 관리하는** HTTPS reverse proxy 또는 tunnel이 필요할 수 있습니다.

공개 JK는 특정 프록시, tunnel 서비스, DNS 공급자 또는 클라우드 호스트를 설치·생성·관리하지 않습니다. 외부 HTTPS endpoint를 이미 운영한다면 launcher의 `PUBLIC_HOSTNAME`/`--public-hostname`으로 그 hostname을 알려 OAuth/MCP metadata에 사용할 수 있습니다.

예:

```bash
PUBLIC_HOSTNAME=mcp.example.com npm run chatgpt
```

이 값은 **메타데이터**일 뿐이며 JK가 해당 hostname을 인터넷에 노출해 주지는 않습니다.

## 4. Remote executor

다른 머신을 worker로 연결하려면 먼저 hub에서 executor token을 발급한 뒤 worker에서 실행합니다.

```bash
node dist/cli.js executor \
  --hub https://your-managed-mcp-host.example \
  --executor-id worker-1 \
  --workspace ~/workspace \
  --token-file /path/to/executor-token
```

Windows에서도 `start-jk.ps1`의 `ExecutorHubUrl`, `ExecutorId`, `ExecutorWorkspace`, `ExecutorTokenFile` 옵션을 사용할 수 있습니다.

## 5. 개인/호스트 운영 설정 분리

개인 도메인, 상시 서버, 자동 배포, reverse proxy, 서비스 관리자 설정은 공개 저장소에 넣지 않는 것을 권장합니다.

JK가 제공하는 host-local 확장 지점:

- `~/.local/share/jk/local/launcher.sh` (legacy installations: `~/.local/share/chatgpt2codex/local/launcher.sh`)
- `~/.local/share/jk/control-center/quick-links.json` (legacy installations: `~/.local/share/chatgpt2codex/control-center/quick-links.json`)

자세한 내용은 `docs/LOCAL_OVERRIDES.md`와 `docs/EXECUTION_POLICY.md`를 참고하세요.

---

# JK Installation Guide

The public JK distribution is a **local MCP harness**. Node.js 22+ and npm are sufficient for the source-based install.

```bash
git clone <repository-url>
cd jk-mcp
npm ci
npm run build
npm run chatgpt
```

On Windows use:

```powershell
npm run chatgpt:windows
```

JK binds to loopback by default. If your ChatGPT client requires an internet-reachable HTTPS endpoint, configure that transport outside JK and pass its hostname through `PUBLIC_HOSTNAME` or `--public-hostname`. JK does not provision or operate a cloud host, DNS provider, reverse proxy, or tunnel in the public distribution.

For host-specific operations, see `docs/LOCAL_OVERRIDES.md`.
