# JK 설치 가이드

JK의 기본 배포 방식은 **사용자 PC에서 직접 실행하는 로컬 런타임**입니다. 지인이 JK를 사용하기 위해 OCI, AWS, 개인 VPS 같은 상시 서버를 운영할 필요는 없습니다.

> 재배포 전에는 [Attribution & Compliance](ATTRIBUTION_AND_COMPLIANCE.md)를 먼저 확인하세요. 이 문서는 기술적인 설치/배포 절차를 설명하며 upstream 라이선스 문제를 해결하거나 별도 재배포 권한을 부여하지 않습니다.

## 가장 쉬운 설치: Windows

GitHub Releases에서 다음 둘 중 하나를 받습니다.

| 파일 | 추천 대상 | 설명 |
| --- | --- | --- |
| `JK-<version>-Windows-Setup.exe` | 대부분의 사용자 | 설치형. 가장 쉬운 경로 |
| `JK-<version>-Windows-Portable.zip` | 설치 없이 사용 | 압축 해제 후 `JK.exe` 실행 |

### 설치형

1. 이 저장소의 GitHub **Releases**에서 `JK-<version>-Windows-Setup.exe`를 다운로드합니다.
2. 파일을 실행합니다.
3. SmartScreen이 나타나면 파일이 이 저장소의 공식 Release에서 받은 것인지 다시 확인합니다.
4. 설치 후 **JK**를 실행합니다.
5. 시계 근처 시스템 트레이에 JK 아이콘이 보이는지 확인합니다.

### Portable

1. `JK-<version>-Windows-Portable.zip`을 다운로드합니다.
2. 원하는 폴더에 압축을 풉니다.
3. 폴더 안의 `JK.exe`를 실행합니다.

Portable은 소스 저장소가 필요 없고, 패키지에 포함된 런타임을 사용합니다.

## 첫 설정

1. 시스템 트레이의 **JK** 아이콘을 누릅니다.
2. **Settings...**를 엽니다.
3. **Project folder**에서 ChatGPT가 작업할 폴더를 선택합니다.
4. ChatGPT 웹에서 사용할 경우 **ChatGPT web connector**를 켭니다.
5. 개인 도메인이 없다면 hostname은 비워둡니다.
6. **Start MCP**를 누릅니다.
7. **Copy Connector URL**을 누릅니다. URL은 `/mcp`로 끝나야 합니다.
8. ChatGPT의 **Apps / Connectors** 설정에서 새 커넥터를 추가하고 URL을 붙여넣습니다.
9. 연결 승인 시 JK 앱에 표시되는 **Owner Token**을 사용합니다.

Owner Token은 비밀번호처럼 취급하세요. 메신저, Issue, 스크린샷, 로그에 공개하지 마세요.

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
- `jk.maintainer.example`
- `mcp.maintainer.example`
- 유지보수자의 개인 서버

다만 ChatGPT 웹은 사용자 PC의 `127.0.0.1`에 직접 접속할 수 없으므로 **웹에서 사용할 때는 인터넷에서 접근 가능한 HTTPS 경로**가 필요합니다.

JK의 Windows 패키지는 초보자용으로 Cloudflare Quick Tunnel 경로를 포함합니다. hostname을 비워두면 임시 URL을 사용할 수 있습니다.

### Quick Tunnel의 특징

- OCI나 개인 서버가 필요 없습니다.
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

현재 Windows 배포 파일은 코드 서명이 없는 개발 빌드일 수 있습니다. 반드시 이 저장소의 Release에서 받은 파일인지 확인하세요.

### E2E 스크린샷이 안 나옴

Windows 웹 E2E는 설치된 Microsoft Edge 또는 Google Chrome을 사용합니다. 브라우저가 설치되어 있는지 확인하세요.

## 업데이트

설치형 사용자는 새 GitHub Release의 `JK-<version>-Windows-Setup.exe`를 받아 다시 설치하는 경로가 가장 단순합니다.

Portable 사용자는 새 ZIP을 별도 폴더에 풀고 실행한 뒤, 필요한 로컬 설정만 옮기는 방식을 권장합니다. 오래된 `dist`나 `JK.exe`를 새 버전 폴더와 섞지 마세요.

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

## OCI / Remote executor는 언제 필요한가요?

일반 사용자에게는 필요 없습니다.

OCI 같은 상시 control plane은 다음과 같은 고급 운영 상황에서만 고려할 수 있습니다.

- PC가 꺼져 있어도 항상 같은 endpoint를 유지하고 싶을 때
- 여러 머신을 remote executor로 묶을 때
- 개인 도메인과 상시 tunnel을 직접 운영할 때

이 경우에도 개인 인프라 설정은 공개 기본 설치 흐름과 분리하는 것을 권장합니다. 호스트별 확장은 [LOCAL_OVERRIDES.md](LOCAL_OVERRIDES.md), 실행 정책은 [EXECUTION_POLICY.md](EXECUTION_POLICY.md)를 참고하세요.

---

# English quick install

For normal Windows users, **OCI is not required**. Download either `JK-<version>-Windows-Setup.exe` or `JK-<version>-Windows-Portable.zip` from this repository's GitHub Releases.

Launch JK, select a project folder, enable **ChatGPT web connector**, leave the hostname blank for a temporary Quick Tunnel, click **Start MCP**, copy the `/mcp` Connector URL, and add it in ChatGPT **Apps / Connectors**. Use the local Owner Token when approval is requested.

The default local port is `7979`. Quick Tunnel URLs can change after restart; a personal domain or Named Tunnel is optional and only needed for a stable URL.

Source builds require Node.js 22+ and npm.
