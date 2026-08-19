# ChatGPT To Codex — 데스크톱 제어 강화 리서치 & 제안서

> 생성: 2026-07-08 · 방법: 7관점 웹 리서치 팬아웃 → 적대적 검증(32 에이전트) → 종합. 제품원칙(loopback-only, 공용릴레이 미운영, 프로젝트 한정+owner 토큰, macOS 우선, Option B 사람 확인형) 기준 평가.

## Executive Summary

chatgpt2codex의 데스크톱 제어를 '더 강력하게'는 자율성 확대가 아니라 '사람이 검증 가능한 정밀 제어 + 확실한 안전 하한선'을 먼저 세우는 방향이 제품원칙(loopback-only, 공용릴레이 미운영, 프로젝트 한정+owner 토큰, macOS 우선, Option B 사람 확인형)과 정합한다. 현재 코드는 screencapture/osascript 셸아웃 기반 스크린샷+스크롤만 있고 클릭/입력 프리미티브·AX·확인 게이트가 없다(src/e2e/local-e2e.ts). 따라서 최우선은 (1) Option B 확인 게이트, (2) 글로벌 kill switch, (3) 좌표가 아닌 macOS Accessibility(AXUIElement) 기반 '의미 타깃팅'과 실행 전 요소 미리보기다. 이 셋이 확인형 제어의 신뢰성을 결정한다. 검증에서 뒤집힌 근거들은 반영했다: OpenAI computer-use 단가는 공개돼 있어(입력 $3/출력 $12·배치 절반) '비용 불확실'을 이유로 서버측 자율 백엔드를 회피할 근거가 약해졌고, 반대로 OSWorld에서 Opus 4.8이 '최상위'라는 주장은 거짓(83.4%로 3~4위, 최상위 ~85%)이라 'Anthropic을 무조건 기본값'으로 두는 설계는 강등하고 BYO-key 교체형으로 완화했다. macOS AX 트리 스캔이 '수 초'라는 우려도 과장(전형 ~50ms)이라 AX 축은 성능 부담 없이 채택 가능하다. Codex CLI 위임은 '서드파티 computer-use MCP 필수'가 아니라 선택지이며(Codex 앱 내장 Computer Use 존재), Anthropic 인젝션 분류기는 게이트를 '대체'하지 못하는 보완 신호로 재분류했다.

## 검증에서 보정된 사실 (adversarial verify)

- OpenAI computer-use-preview 토큰 단가는 공개돼 있다(표준 입력 $3/출력 $12 per 1M, 배치 절반 $1.50/$6). 리서치의 '단가 미확인→비용 예측 불확실'은 refuted. 단 Tier 3+ 접근 제한과 tool-call당 부가요금 가능성은 남는 진짜 불확실성. 또한 computer-use-preview 스냅샷은 2026-07-23 종료·gpt-5.4-mini 대체 권장.
- OSWorld-Verified에서 Opus 4.8이 '최상위'라는 주장은 거짓(partly). Opus 4.8=83.4%로 3~4위이고 최상위는 Fable5/Mythos 계열 ~85%. Sonnet 5(81.2%)>GPT-5.5(78.7%)와 인간기준 72.4%는 확인. 'Sonnet 4.6 대비 +2.7점'도 불일치. 결론: Anthropic이 GPT-5.5보다 앞서나 '압도적 1위'는 아님 → 백엔드는 교체형·BYO-key로.
- macOS AX 트리 스캔이 '수 초'라는 성능 우려는 과장(partly). 전형 ~50ms, 수 초는 ~2000요소 대형 창의 worst-case이며 '수 초' 관측은 Linux 사례였음. 재시도는 스캔 지연 은폐가 아니라 async UI 안정화 목적. → AX 의미 타깃팅은 성능상 채택 가능.
- 'CLI 화면제어는 서드파티 computer-use MCP 연결이 필수'는 과장(partly). Codex 앱에 내장 Computer Use 플러그인(macOS/Windows)이 존재. 서드파티 stdio MCP(macuse-mcp, mac-computer-use, open-codex-computer-use)는 하나의 선택지. wousp112/codex-computer-use-mcp는 방향이 반대(Codex 내장 CU를 다른 MCP 클라이언트에 노출)로 오분류였음.
- Anthropic 스크린샷 인젝션 분류기는 Option B와 '직접 정합/대체'가 아니라 보완적. 하드 차단이 아닌 모델 확률적 '유도(steer)'이며 opt-out은 support 컨택 필요. 제품 레벨 명시적 확인 게이트를 대체할 수 없고 신호로만 게이트에 공급해야 함.
- trycua/cua의 '커서/포커스 미탈취 제어'는 macOS/Windows에 해당하고 Linux 제어는 pre-release. '~97% 근네이티브'는 벤더 마케팅 상한값(독립 벤치 아님), 'verify' 액션은 문서 미확인. → VM 격리는 later/avoid, MCP 툴 패턴만 참조.

## 제안 (임팩트 순위, 티어 분류)

### NOW — 지금 (Option B 신뢰성 하한선)

#### [1] Option B 확인 게이트 (액션 프리뷰 + binding-message 승인)
- **효과**: 모든 데스크톱 제어 액션을 실행 전 '앱X의 버튼 Send를 클릭합니다'처럼 그 자체로 판단 가능한 binding message로 프리뷰하고, 되돌릴 수 없는/고위험(결제·전송·삭제·약관동의) 액션은 명시 승인 후에만 실행. 권한 스코프가 아닌 거래 확인형 문구.
- **구현 접근**: src/server/tools.ts의 제어 툴에 pre-exec 승인 단계 삽입; 승인 요청/응답은 로컬 http.ts 채널로. tool-proof.ts의 per-turn proof 패턴을 승인 결과에도 확장.
- **effort** `M` · **risk** `low`
- **제품원칙 정합**: Option B의 코어. loopback·owner 토큰·프로젝트 한정과 충돌 없고 전부 로컬 완결. 모든 제어 프리미티브의 진입 게이트가 됨.
- 출처: https://openai.com/index/operator-system-card/, https://mastra.ai/blog/human-in-the-loop-when-to-use-agent-approval, https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

#### [2] 글로벌 kill switch (전역 핫키 + 상태바 Stop)
- **효과**: 전역 핫키(예 ⌥⇧Esc)와 상태바 Stop이 진행 중 액션을 즉시 중단하고 대기 큐를 비우며 owner 세션의 제어 툴 권한을 회수. 런타임 바깥(브리지 control plane)에서 강제하는 하드스톱.
- **구현 접근**: macos StatusBar(main.swift)에 Stop 항목 + 전역 핫키; 브리지 서버에 중단 플래그를 두고 제어 툴 실행 루프가 매 스텝 확인·큐 드레인.
- **effort** `S` · **risk** `low`
- **제품원칙 정합**: control plane이 이미 로컬 브리지라 추가 인프라 불필요. Option B의 안전 하한선으로 게이트보다 먼저/함께 구현.
- 출처: https://www.codebridge.tech/articles/ai-agent-guardrails-for-production-kill-switches-escalation-paths-and-safe-recovery, https://killswitch.md/

#### [3] AX 시맨틱 타깃팅 엔진 (AXUIElement role+title/description resolve → AXPress/AXSetValue)
- **효과**: cliclick식 픽셀 좌표를 대체/보강. kAXChildrenAttribute 트리 순회 + role/title 속성 검사로 요소를 식별하고 AXUIElementPerformAction(el, "AXPress")로 좌표 비의존 클릭. 해상도·창 위치·레이아웃 변화에 강건.
- **구현 접근**: 신규 Swift 헬퍼 또는 axcli/macapptree(MIT / MIT-OR-Apache) 흡수. AX 검색 내장함수는 없으니 트리 순회+속성 필터를 직접 구현. 메인스레드 호출·AXUIElementCopyActionNames로 AXPress 지원 사전 확인.
- **effort** `L` · **risk** `med`
- **제품원칙 정합**: macOS 우선과 직결. Accessibility 권한 owner 1회 승인, 표적을 프로젝트 지정 앱/창으로 스코프하면 프로젝트 한정과 부합. 성능은 전형 ~50ms로 문제 없음(검증 보정).
- 출처: https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction, https://crowecawcaw.github.io/general/2026/05/30/accessibility-for-computer-use.html, https://github.com/andelf/axcli, https://github.com/MacPaw/macapptree

#### [4] 실행 전 요소 미리보기 (dry-run resolve: role/title/frame/소속 앱·창)
- **효과**: 클릭 직전 어떤 요소가 눌리는지 확인 UI에 표시하고, 다중 매칭이면 후보 목록을 제시해 오작동 방지. Option B 확인 품질을 급상승시킴.
- **구현 접근**: AX 엔진 resolve 결과(role/title/frame/bundleID)를 게이트 프리뷰 payload로 전달. 애매하면 후보 배열 반환.
- **effort** `S` · **risk** `low` · **의존** AX 시맨틱 타깃팅 엔진
- **제품원칙 정합**: 확인형 제어의 신뢰성 핵심. 추가 네트워크·권한 없음. 완전 정합.
- 출처: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool, https://github.com/browser-use/macOS-use

#### [5] cliclick/CGEvent 네이티브 입력 프리미티브 (click/type/drag/key, 게이트 뒤)
- **효과**: AX가 AXPress를 노출하지 않는 요소·순수 좌표 입력을 위한 경량 실행기. Homebrew cliclick 셸아웃 또는 CGEvent 직접 합성. N-API 네이티브 빌드·상용 라이선스 불필요.
- **구현 접근**: local-e2e.ts의 execFileAsync 패턴 재사용해 cliclick 셸아웃. Retina 논리px↔물리px 스케일 변환 유의.
- **effort** `S` · **risk** `low` · **의존** Option B 확인 게이트
- **제품원칙 정합**: macOS 우선·최소변경·permissive. 좌표 방식도 어차피 동일 Accessibility 권한을 요구하므로 권한 확대 없음. 반드시 확인 게이트 통과 후에만 호출.
- 출처: https://github.com/BlueM/cliclick, https://github.com/BlueM/cliclick/blob/master/README.md

#### [6] 표적 스코프 가드 (앱/bundleID allowlist + 금융·비밀번호 blocklist)
- **효과**: 제어 가능한 AX/좌표 표적을 프로젝트 지정 앱/창으로 allowlist 제한하고 금융·암호화폐·시스템 설정·비밀번호 관리자는 기본 blocklist. 오작동·인젝션 폭발반경 축소.
- **구현 접근**: src/policy 및 workspace/registry.ts의 프로젝트 스코프에 controlAllowlist/blocklist 추가; 게이트 진입 시 frontmost bundleID 대조.
- **effort** `S` · **risk** `low` · **의존** Option B 확인 게이트
- **제품원칙 정합**: 프로젝트 한정+owner 토큰 원칙을 제어 실행 계층에 직접 매핑. Anthropic 기본 blocklist 권고와 동일. 저비용 고효과.
- 출처: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

#### [7] 라이브 권한 프리플라이트 (CGEvent.tapCreate listenOnly)
- **효과**: macOS 업데이트 후 AXIsProcessTrusted stale-true 버그로 인한 조용한 실패를 차단. 실제 AX 사용 가능 여부를 라이브로 확인 후에만 제어 허용, 없으면 즉시 재승인 안내.
- **구현 접근**: 제어 진입점에서 CGEvent tap 생성 성공 여부로 프로브; 실패 시 DomainError PERMISSION_DENIED + 안내.
- **effort** `S` · **risk** `low`
- **제품원칙 정합**: 안정성 향상, 로컬 전용. 기존 PERMISSION_DENIED 분기(local-e2e.ts)와 동일 패턴.
- 출처: https://developer.apple.com/forums/thread/794253, https://fazm.ai/blog/macos-ai-agent

#### [8] 전/후 스크린샷 증빙 캡처 + binding-message 감사 로그
- **효과**: 액션 전/후 스크린샷을 확인 UI·감사 로그에 인라인 첨부하고 승인/거부/실행을 who-what-when으로 로컬 기록. 라이브 프루프 원칙 구현 + 규제(인간 감독 증명) 대응.
- **구현 접근**: 기존 screenshot-share.ts / screenshot-preview 확장; 감사 로그는 .ai/outputs 또는 프로젝트 로컬 append.
- **effort** `S` · **risk** `low`
- **제품원칙 정합**: 라이브 프루프 우선·릴레이 미운영·프라이버시와 정합. 로컬 파일만 사용.
- 출처: https://galileo.ai/blog/human-in-the-loop-agent-oversight, https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

### NEXT — 다음

#### [9] 실행 후 검증 (AXObserver 기반 상태변화 관찰)
- **효과**: 액션 후 포커스 이동/값 변경/알림을 관찰해 '클릭했다 주장'이 아니라 실제 효과를 라이브로 판정하고 재시도 근거·감사 증거로 사용.
- **구현 접근**: AXObserver로 대상 요소/앱 알림 구독; 타임아웃 내 기대 변화 미관측 시 실패 보고.
- **effort** `M` · **risk** `med` · **의존** AX 시맨틱 타깃팅 엔진
- **제품원칙 정합**: 라이브 증거·감사 원칙과 정합, 로컬 관찰. AX 엔진 위에 자연스럽게 얹힘.
- 출처: https://developer.apple.com/documentation/applicationservices/axuielement, https://github.com/simular-ai/Agent-S

#### [10] 민감 단계 take-over 모드 (로그인·결제 시 사람 인계, 캡처 중단)
- **효과**: 로그인·결제·비밀번호 입력 구간에서 자동 일시정지하고 사람에게 제어를 넘기며 해당 구간 스크린샷/입력 캡처를 중단. owner 자격증명 노출 위험 축소.
- **구현 접근**: blocklist/휴리스틱(암호 필드 role=AXSecureTextField 감지)으로 트리거; take-over 동안 screencapture 파이프라인 일시중단.
- **effort** `M` · **risk** `low` · **의존** 표적 스코프 가드
- **제품원칙 정합**: Operator 검증 패턴. 프라이버시·보안 우선과 강한 정합.
- 출처: https://help.openai.com/en/articles/10421097, https://openai.com/index/introducing-operator/

#### [11] 온디바이스 스크린샷 PII/자격증명 마스킹 (ChatGPT 전송 전)
- **효과**: 스크린샷을 비신뢰 클라우드(ChatGPT)로 내보내기 전 macOS 로컬에서 OCR+객체탐지로 PII·토큰·인접창을 blur/블랙박스. 게이트웨이 경계 마스킹을 브리지에 적용.
- **구현 접근**: Vision.framework(온디바이스 OCR)+영역 마스킹; screenshot-share.ts 전송 직전 훅. 기본 보수적 마스킹, 프로젝트 정책으로 강도 조절.
- **effort** `L` · **risk** `med` · **의존** 전/후 스크린샷 증빙 캡처
- **제품원칙 정합**: 화면을 ChatGPT로 내보내는 제품 구조상 필수급 방어. 로컬 처리라 릴레이 미운영·로컬 우선과 강하게 정합. 리스크는 오탐 시 유용성 저하.
- 출처: https://pctechmag.com/2026/06/pii-redaction-for-llms-in-2026-how-to-strip-sensitive-data-before-it-leaves-your-perimeter/, https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

#### [12] Codex 위임 실행기 어댑터 (codex exec --json / @openai/codex-sdk) + 프로젝트 스코프 .codex 프로비저닝 + 네이티브 승인 매핑
- **효과**: 브리지가 상위 목표만 넘기고 Codex가 로컬에서 화면/코딩 루프를 돌며 JSONL 이벤트를 브리지로 스트리밍. .codex/config.toml에 trust_level=trusted + sandbox_mode=workspace-write + default_tools_approval_mode=prompt를 심어 Option B를 Codex 네이티브 승인면에 매핑.
- **구현 접근**: @openai/codex-sdk를 자식 프로세스로 래핑해 ThreadEvent 파싱; 선택 프로젝트에만 .codex/config.toml 프로비저닝. 대화형 승인 채널이 필요하므로 headless never 모드와 배타.
- **effort** `M` · **risk** `med` · **의존** Option B 확인 게이트
- **제품원칙 정합**: 브리지는 loopback 얇은 오케스트레이터로 남고 실제 실행은 로컬 Codex 소유 → owner 토큰·프로젝트 한정 유지. 자동화 인증은 API 키 권장(브리지가 키 관리). 보정: 서드파티 computer-use MCP는 '필수'가 아닌 선택.
- 출처: https://developers.openai.com/codex/noninteractive, https://developers.openai.com/codex/config-reference, https://developers.openai.com/codex/sdk

#### [13] 클릭 위치 미리보기 오버레이 (NSPanel .nonactivatingPanel)
- **효과**: 다음 클릭 목표 좌표/요소 frame을 화면 위에 하이라이트해 실행 전 사람 눈으로 검증. 좌표 환각 리스크 차단.
- **구현 접근**: macos 앱에 nonactivating 오버레이 패널; AX resolve된 frame 또는 좌표를 하이라이트.
- **effort** `M` · **risk** `med` · **의존** 실행 전 요소 미리보기
- **제품원칙 정합**: macOS 우선과 부합. 승인 큐와 결합 시 오탐 방지 효과 큼. 리스크는 다중 디스플레이/스케일링 처리.
- 출처: https://www.peterarsenault.industries/posts/macos-status-bar-apps/part01/, https://www.mindstudio.ai/blog/what-is-claude-code-computer-use

#### [14] Electron/웹 a11y 활성화 어댑터 (AXManualAccessibility)
- **효과**: VS Code 등 Electron 대상에서 AXUIElementSetAttributeValue로 AXManualAccessibility를 켜 접근성 트리를 노출한 뒤 AX 질의. 코딩 대상 앱 커버리지 확대.
- **구현 접근**: 대상 bundleID가 Electron이면 AXManualAccessibility=true 설정 후 트리 재질의; 종료 시 원복.
- **effort** `M` · **risk** `med` · **의존** AX 시맨틱 타깃팅 엔진
- **제품원칙 정합**: 코딩 지원 목적에 부합하나 사용자 앱 접근성 상태를 토글하고 성능 비용이 있어 기본 off·명시 승인 시 on·되돌리기 필요.
- 출처: https://www.electronjs.org/docs/latest/tutorial/accessibility/, https://github.com/electron/electron/pull/10305

#### [15] JIT TTL 시간·앱 범위 승인 배치
- **효과**: '이 앱에서 5분간 클릭 허용'처럼 앱/액션유형·시간으로 범위를 한정한 grant를 발급하고 TTL 만료 시 자동 회수. 승인 피로도 감소.
- **구현 접근**: 승인 게이트에 TTL+scope 필드; 만료 타이머로 grant 무효화. 기본은 건별 승인.
- **effort** `M` · **risk** `med` · **의존** Option B 확인 게이트
- **제품원칙 정합**: 프로젝트 한정+owner 토큰의 데스크톱 확장. 리스크는 범위 과다 부여 → 기본 좁게, 만료·범위 명시.
- 출처: https://www.linx.security/blog/just-in-time-access-primer-from-humans-to-agents, https://w3c.github.io/permissions/

### LATER — 이후

#### [16] 교체 가능한 서버측 CUA 판단기 어댑터 (BYO-API-key, Anthropic Computer Use / OpenAI computer 툴)
- **효과**: ChatGPT 웹의 비전-액션 단절을 브리지 서버가 우회해 진짜 자율 실행. 스크린샷→좌표/액션 판단 루프를 백엔드 인터페이스 뒤에 두고 사용자 소유 키로만 호출.
- **구현 접근**: computer_20251124(Anthropic) / Responses API computer 툴(gpt-5.4/5.5) 어댑터 인터페이스; macOS 네이티브 스크린샷+Retina 좌표 스케일링 실행기; 턴상한·예산 거버너로 폭주 방지. 모든 결과성 액션은 Option B 게이트로 승격.
- **effort** `L` · **risk** `med` · **의존** Option B 확인 게이트
- **제품원칙 정합**: BYO-key는 '공용 릴레이 미운영·사용자 소유' 원칙의 판단기 버전. 보정: OSWorld에서 Anthropic이 GPT-5.5보다 앞서나 '압도적 1위'는 아니므로 특정 벤더 하드 기본값이 아닌 사용자 키 기반 교체형. 인젝션 분류기는 게이트 대체가 아닌 보완 신호로만.
- 출처: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool, https://developers.openai.com/api/docs/guides/tools-computer-use, https://developers.openai.com/api/docs/deprecations

#### [17] 웹 표적용 Playwright/CDP 라우팅 (AX는 네이티브 전담)
- **효과**: ChatGPT 웹·웹 대시보드 등 웹 표적을 DOM·aria 셀렉터로 안정 제어. AX(네이티브)+Playwright(웹) 이원 라우팅으로 강건성 극대화.
- **구현 접근**: electronApplication.evaluate로 다이얼로그 스텁 대체; 네이티브 다이얼로그는 AX로 폴백.
- **effort** `L` · **risk** `med` · **의존** AX 시맨틱 타깃팅 엔진
- **제품원칙 정합**: 로컬 브라우저 제어라 loopback·프로젝트 한정과 정합. 단 Electron main의 네이티브 다이얼로그는 못 다뤄 AX 폴백 필요. 의존성·복잡도 증가로 후순위.
- 출처: https://playwright.dev/docs/api/class-electron, https://github.com/microsoft/playwright/issues/8278

#### [18] 크로스플랫폼 확장 기반 (세션/디스플레이 감지 가드 + 권한 닥터, Windows/Linux 백엔드)
- **효과**: 제어 전 플랫폼·세션(X11/Wayland/헤드리스, Windows 무결성레벨·Session0)을 감지해 미지원 환경을 사유와 함께 거부. 기존 데스크톱 dependency doctor의 크로스플랫폼판. Windows는 UIA+SendInput(비상승 제약 문서화), Linux는 X11 우선·Wayland 포털 폴백.
- **구현 접근**: local-e2e.ts의 NOT_IMPLEMENTED/PERMISSION_DENIED 분기를 플랫폼 감지 레이어로 일반화; 입력코어는 enigo(Rust, X11/Win/mac 신뢰, Wayland/libei 실험).
- **effort** `L` · **risk** `med` · **의존** 세션/디스플레이 감지 가드
- **제품원칙 정합**: 순수 로컬 판정이라 원칙 충돌 없음. macOS 우선을 깨지 않고 확장 기반만 마련. Wayland 포털 승인 프롬프트는 오히려 사람 확인형과 정합.
- 출처: https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/uipi-issues, https://github.com/ReimuNotMoe/ydotool, https://github.com/enigo-rs/enigo

### AVOID — 회피 권고

#### [19] cua Apple Virtualization VM 샌드박스 격리 실행
- **효과**: 파괴적/불확실 작업을 격리 VM에서 실행해 실 PC 보호.
- **구현 접근**: 채택 대신 참조. 필요 시 별도 옵트인 고급 모드.
- **effort** `XL` · **risk** `high`
- **제품원칙 정합**: 낮음. 경량 loopback·개인 PC 보조 성격과 무게가 상충. 보정: cua Linux 제어 pre-release, ~97%는 벤더 마케팅. MCP 툴 인터페이스 패턴만 참조하고 VM 전체 임베드는 엔터프라이즈 옵션으로만.
- 출처: https://github.com/trycua/cua, https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md

#### [20] nut.js/robotjs 입력 라이브러리 및 비상업 에이전트(MacOS-Agent) 채택
- **효과**: 크로스플랫폼 마우스·키보드 제어 라이브러리.
- **구현 접근**: 미채택.
- **effort** `M` · **risk** `high`
- **제품원칙 정합**: 낮음. nut.js는 2024 구독형 상용 전환(라이선스 리스크), robotjs 미유지보수, MacOS-Agent는 CC BY-NC(상업 불가). cliclick+AX(+필요 시 enigo)로 대체.
- 출처: https://nutjs.dev/blog/i-give-up, https://github.com/Computer-use-agents/MacOS-Agent, https://github.com/octalmage/robotjs

## 권장 로드맵

now(안전 하한선+정밀 제어 코어): Option B 확인 게이트와 글로벌 kill switch를 먼저 세워 '승인 없이는 아무것도 실행 안 됨 + 언제든 즉시 중단' 상태를 만든 뒤, 그 게이트 뒤에 AX 시맨틱 타깃팅 엔진·실행 전 요소 미리보기·cliclick 입력 프리미티브를 연결한다. 여기에 표적 스코프 가드(allowlist/blocklist)·라이브 권한 프리플라이트·전후 스크린샷 증빙+감사 로그를 붙이면 '사람이 무엇을 클릭하는지 정확히 보고 승인하는' 확인형 제어가 완성된다. 이 묶음은 전부 macOS 로컬·permissive·저위험이라 제품원칙과 정합하고 대부분 S~L 규모다. next(신뢰·프라이버시·오케스트레이션 확장): AXObserver 실행 후 검증으로 '실제 효과'를 증거화하고, take-over 모드와 온디바이스 스크린샷 마스킹으로 비신뢰 클라우드 유출·자격증명 노출을 막는다. Codex 위임 어댑터로 상위 목표 위임 경로를 열고 승인을 Codex 네이티브 승인면에 매핑하며, 클릭 오버레이·Electron a11y 어댑터·JIT TTL 승인으로 커버리지와 UX를 넓힌다. later(자율성·크로스플랫폼): BYO-key 교체형 서버측 CUA 판단기로 진짜 자율 실행을 도입하되 특정 벤더 하드 기본값은 피하고(OSWorld 우열 근거 보정) 모든 결과성 액션을 Option B 게이트로 승격한다. Playwright/CDP 웹 라우팅과 Windows/Linux 백엔드는 그 다음. avoid: VM 격리(무게 과다), nut.js/robotjs(라이선스·유지보수), 비상업 에이전트, 그리고 원칙상 공용 CUA 모델/릴레이 호스팅은 배제한다.

## 열린 리스크

- 좌표 스케일링: Retina 논리px↔물리px 2x 매핑 오류가 클릭 정확도의 최대 실패원인. AX frame과 cliclick/CGEvent 좌표계 일치 검증 필요.
- AX 커버리지 공백: Electron/Chromium(VS Code, ChatGPT 데스크톱) 및 Qt/Python 앱은 트리가 비거나 지연 노출 → AX 단독 불충분, Electron 어댑터/Playwright/좌표 폴백 이원화 불가피.
- 프롬프트 인젝션 잔여 위험: 최상위 모델도 ~1% 공격성공률. 인젝션 분류기는 소프트 유도일 뿐 제품 게이트를 대체 못 함 → 결과성 액션은 항상 명시 확인으로 승격해야 함.
- 서버측 자율 백엔드 마이그레이션: computer-use-preview 2026-07-23 종료, 벤더별 툴 타입·헤더 상이 → 어댑터 추상화와 gpt-5.4/5.5·Anthropic 교체 경로 필요. 비용은 단가 공개로 예측 가능하나 Sonnet5 신토크나이저 ~30% 토큰 인플레이션·고해상 비전 최대 3배 토큰을 산정에 반영.
- 프라이버시 마스킹 오탐/미탐: 온디바이스 마스킹이 민감정보를 놓치면 유출, 과하면 유용성 저하. 보수적 기본값 + 프로젝트 정책 조절 필요.
- 크로스플랫폼 권한/세션: Windows 비상승 프로세스는 상승 창 제어 불가(UIPI), Wayland는 컴포지터별 libei 편차·버그. 기능이 아니라 권한·세션 감지가 핵심 리스크 → macOS 우선 유지가 안전.
- Codex 위임 인증: 자동화는 API 키 권장이라 브리지가 키 관리 책임을 지며 headless never 모드와 대화형 승인이 배타 → 승인 채널 설계 필요.
