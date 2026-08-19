# Local overrides

JK의 공개 코어와 개인/호스트별 운영 설정을 분리하기 위한 확장 지점입니다. 아래 파일은 모두 Git 저장소 밖의 JK state directory에 둡니다.

## Launcher override

기본 경로:

```text
~/.local/share/chatgpt2codex/local/launcher.sh
```

Linux launcher는 이 파일이 실행 가능하면 공개 launcher보다 먼저 호출합니다.

호출 규약:

```text
launcher.sh <public-launcher-path> <original-arguments...>
```

호스트별 서비스 준비, 별도 runtime 선택, private deployment follower 같은 동작은 이 wrapper에서 구현할 수 있습니다. wrapper가 공개 launcher를 다시 실행할 때는 재귀 호출을 막기 위해 `JK_LOCAL_LAUNCHER_ACTIVE=1` 상태가 전달됩니다.

다른 경로를 쓰려면 `JK_LOCAL_LAUNCHER` 환경 변수로 지정할 수 있습니다.

## Control Center Quick Links

기본 경로:

```text
~/.local/share/chatgpt2codex/control-center/quick-links.json
```

예시:

```json
[
  {
    "title": "Internal dashboard",
    "note": "Host-local admin page",
    "badge": "Private",
    "badgeClass": "default",
    "href": "https://example.com/"
  }
]
```

허용되는 `badgeClass`는 `ok`, `warn`, `active`, `default`이며 링크는 `http://` 또는 `https://`만 허용됩니다. 파일이 없으면 JK 기본 Dashboard/Approvals 링크만 표시합니다.

## Boundary

이 override는 개인 배포 설정이나 credentials를 공개 `jk-mcp`에 커밋하지 않기 위한 장치입니다. 공개 코어는 특정 클라우드, reverse proxy, tunnel, systemd unit 또는 자동 배포 방식을 요구하지 않습니다.
