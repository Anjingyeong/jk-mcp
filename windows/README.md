# JK for Windows

JK의 일반 사용자 배포 경로는 **로컬 Windows 앱**입니다. OCI나 유지보수자의 서버는 필요하지 않습니다.

## 무엇을 다운로드하나요?

GitHub Releases에서 다음 중 하나를 받습니다.

- `JK-<version>-Windows-Setup.exe` — 권장. 설치 후 바로 실행
- `JK-<version>-Windows-Portable.zip` — 설치 없이 압축 해제 후 `JK.exe` 실행

Windows 패키지는 release artifact로 배포하고 Git history에는 바이너리를 넣지 않습니다.

## 처음 연결하기

1. JK를 실행합니다.
2. 시스템 트레이의 JK 아이콘에서 **Settings...**를 엽니다.
3. **Project folder**를 선택합니다.
4. ChatGPT 웹에서 사용할 경우 **ChatGPT web connector**를 켭니다.
5. 도메인이 없다면 hostname은 비워둡니다. 임시 Cloudflare Quick Tunnel을 사용할 수 있습니다.
6. **Start MCP**를 누릅니다.
7. **Copy Connector URL**을 눌러 `/mcp` URL을 복사합니다.
8. ChatGPT의 **Apps / Connectors**에서 URL을 등록합니다.
9. 승인 요청에는 로컬 JK 앱의 **Owner Token**을 사용합니다.

Owner Token은 비밀번호처럼 취급하세요.

## OCI가 없어도 되는 이유

JK는 사용자 PC에서 직접 실행됩니다.

```text
ChatGPT web
  -> HTTPS connector
  -> Quick Tunnel (default beginner path)
  -> JK on this Windows PC
  -> selected project folder
```

따라서 Oracle Cloud VM, AWS, `jk.maintainer.example`, `mcp.maintainer.example` 같은 유지보수자 인프라는 일반 사용자에게 필요하지 않습니다.

ChatGPT 웹은 localhost에 직접 접근할 수 없기 때문에 웹 커넥터에는 HTTPS 경로가 필요합니다. 가장 쉬운 방법은 임시 Quick Tunnel입니다. 앱을 재시작하면 주소가 바뀔 수 있으므로 그때 ChatGPT Connector URL도 갱신합니다.

고정 URL이 필요한 사용자만 본인 Cloudflare Named Tunnel + 도메인 또는 다른 HTTPS reverse proxy를 설정하면 됩니다.

## Runtime modes

- **Installed / Portable**: `JK.exe` 옆에 패키징된 `dist`를 사용합니다. 주변 source checkout으로 조용히 넘어가지 않습니다.
- **Development**: 저장소 루트의 launcher 또는 `npm run chatgpt:windows`를 사용합니다. 소스가 새로우면 개발용 `dist`를 다시 빌드할 수 있습니다.
- Control Center에서 active runtime mode를 확인할 수 있습니다.

지인에게 전달하는 것은 **Installed / Portable** 모드입니다. 개발용 checkout을 같이 전달할 필요가 없습니다.

## 기본 로컬 주소

기본 포트는 `7979`입니다.

- Dashboard: `http://127.0.0.1:7979/`
- MCP: `http://127.0.0.1:7979/mcp`
- Health: `http://127.0.0.1:7979/healthz`

ChatGPT 웹에는 localhost 주소가 아니라 JK가 복사해 주는 HTTPS Connector URL을 등록하세요.

## 문제 해결

- **SmartScreen 경고**: 현재 unsigned 개발 빌드일 수 있습니다. 이 저장소의 GitHub Release에서 받은 파일인지 확인한 뒤 실행하세요.
- **Connector URL이 비어 있음**: web connector를 켜고 **Start MCP** 후 다시 복사하세요.
- **포트 7979 충돌**: 트레이 메뉴의 **Restart MCP**를 먼저 사용하세요.
- **Quick Tunnel 주소가 바뀜**: ChatGPT Connector의 URL도 새 `/mcp` 주소로 갱신하세요.
- **ChatGPT 승인 요청**: JK 앱의 Owner Token을 사용합니다.
- **E2E 웹 캡처 실패**: Microsoft Edge 또는 Google Chrome이 설치되어 있는지 확인하세요.

## 처음 써볼 프롬프트

```text
@jk 이 프로젝트를 선택하고 README와 package scripts를 확인해.
수정은 하지 말고 구조와 실행 방법만 설명해줘.
```

```text
@jk 이 버그 원인을 찾고 최소 수정한 뒤 관련 테스트까지 실행해줘.
```

## 개발자용 빌드

요구사항: Node.js 22+, npm, PowerShell.

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

설치 파일 생성:

```powershell
npm run windows:package
```

Portable 앱 폴더 생성:

```powershell
npm run windows:portable
```

GitHub Actions의 Windows Release workflow는 `v*` 태그 또는 수동 실행으로 다음 artifact를 만듭니다.

- `JK-<version>-Windows-Setup.exe`
- `JK-<version>-Windows-Portable.zip`

릴리스 바이너리를 배포하기 전 upstream 라이선스/재배포 조건은 별도로 확인해야 합니다. 자세한 내용은 `docs/ATTRIBUTION_AND_COMPLIANCE.md`를 참고하세요.

Original work © 2026 ezBuilder. All rights reserved.
