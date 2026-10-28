# JK 기능 한눈에 보기

JK가 ChatGPT에 제공하는 MCP 도구 70개를 하는 일별로 묶었습니다. 평소엔 도구 이름을 몰라도 됩니다. "이 버그 고치고 테스트 돌려줘"처럼 말하면 ChatGPT가 알맞은 도구를 고릅니다.

| 묶음 | 도구 수 |
|---|---|
| [작업 기억 (세션 이어가기)](#memory) | 11 |
| [코드 파악](#understand) | 8 |
| [안전한 수정](#edit) | 4 |
| [실행과 검증](#verify) | 9 |
| [Git](#git) | 8 |
| [큰 작업 진행](#orchestrate) | 6 |
| [품질 감시 (Impulse)](#impulse) | 6 |
| [이미지](#image) | 11 |
| [데스크톱 제어 (승인 기반)](#desktop) | 4 |
| [운영](#ops) | 3 |

<a id="memory"></a>
## 작업 기억 (세션 이어가기)

대화가 끊겨도 하던 일을 그대로 이어감. 목표, 건드린 파일, 남은 일, 결정 사항이 프로젝트별로 저장되고, 다시 불러올 때 그 사이 파일이 바뀌었는지 검사함.

| 도구 | 하는 일 |
|---|---|
| `project_select` | 프로젝트를 고르고 작업 권한(lease)을 잡음. 이후 모든 도구가 이 프로젝트 안에서만 동작 |
| `work_session_list` | 이 프로젝트에서 했던 작업 세션 목록과 이어서 할 후보 순위 |
| `session_resume` | 이전 작업의 목표·건드린 파일·남은 일·결정을 불러오고, 그 사이 파일이 바뀌었는지 해시로 검사 |
| `project_feedback_record` | "UI 너무 밝아" 같은 사용자 피드백을 프로젝트별로 기억 |
| `known_fix_search` | 예전에 고친 증상과 해결법을 먼저 찾아봄 |
| `known_fix_add` | 검증된 증상→해결법을 프로젝트 기억에 저장 |
| `analysis_cache_get` | 프로젝트가 안 바뀌었으면 예전 분석·리뷰 결과 재사용 |
| `analysis_cache_put` | 분석·리뷰 결과를 프로젝트 지문과 함께 저장 |
| `checkpoint_list` | 파일을 바꿀 때마다 자동으로 남는 체크포인트 목록 |
| `checkpoint_show` | 체크포인트의 변경 내용 보기 (비밀값 가림) |
| `checkpoint_restore` | 체크포인트 시점으로 되돌리기 |

<a id="understand"></a>
## 코드 파악

필요한 부분만 정확히 읽어서 컨텍스트를 아낌.

| 도구 | 하는 일 |
|---|---|
| `workspace_list_projects` | 작업 폴더에 등록된 프로젝트 목록 |
| `workspace_get_project` | 프로젝트 하나의 정보 |
| `workspace_refresh_index` | 작업 폴더 다시 훑어서 프로젝트 목록 갱신 |
| `project_status` | git 상태·규칙 파일·실행 가능한 명령 요약 |
| `project_rules` | AGENTS.md·CLAUDE.md 같은 규칙 파일을 경로별로 읽음 |
| `code_search` | ripgrep 기반 코드 검색 (프로젝트 안만) |
| `code_context_pack` | 주제 하나에 필요한 코드 조각을 묶어서 전달 |
| `file_read_slice` | 파일의 필요한 줄만 읽고 줄마다 해시 첨부 |

<a id="edit"></a>
## 안전한 수정

다른 사람(또는 다른 작업)이 먼저 바꾼 내용을 덮어쓰지 않음.

| 도구 | 하는 일 |
|---|---|
| `file_apply_patch` | 읽은 뒤에 파일이 바뀌었으면 거부하는 패치 (해시 조건 + 통째로 적용 아니면 취소) |
| `file_create` | 새 파일 만들기 (덮어쓰기는 명시해야 함) |
| `show_changes` | 커밋·되돌리기 전에 지금 변경 내용 확인 |
| `task_workspace` | 원본과 분리된 작업용 사본에서 구현·검증하고, 검증된 것만 원본에 반영 |

<a id="verify"></a>
## 실행과 검증

"됐을 거예요"가 아니라 실제로 돌린 결과를 증거로 돌려줌.

| 도구 | 하는 일 |
|---|---|
| `command_list` | package.json 등에서 찾은 허용 명령 목록 |
| `command_run` | 허용된 명령만 실행 (임의 셸 불가) |
| `local_shell_run` | 임의 셸 명령 실행. 프로젝트 폴더 안에서만, 비밀 경로·시스템 파괴 명령은 차단, 위험한 작업은 주인 승인 |
| `e2e_start_server` | 개발 서버 띄우고 주소가 열릴 때까지 대기 |
| `e2e_open_target` | E2E 확인용으로 URL이나 앱 열기 |
| `e2e_run_command` | E2E·테스트 명령 실행하고 화면 캡처 |
| `e2e_test_and_show_screenshot` | "E2E 돌리고 스샷 보여줘" 한 번에 처리 |
| `e2e_screenshot` | 현재 화면 캡처 (macOS/Windows) |
| `e2e_open_url_screenshot` | 로컬 주소 열고 브라우저 화면 캡처 |

<a id="git"></a>
## Git

읽기는 자유롭게, 커밋·푸시는 확인한 것만 명시적으로.

| 도구 | 하는 일 |
|---|---|
| `repo_status` | 저장소 상태와 원격 관계 (읽기 전용) |
| `repo_diff_summary` | 변경 요약 (비밀값 가림, 읽기 전용) |
| `git_status` | 예전 이름 (repo_status 권장) |
| `git_diff_summary` | 변경 요약 (비밀값 가림) |
| `git_commit` | 확인한 변경만 커밋 |
| `git_push` | 사용자가 명시했을 때만 푸시 |
| `git_sync_start` | 원격 작업 전 깨끗한 상태 확인 후 최신 받기 |
| `git_sync_finish` | 검증 끝난 경로만 커밋하고 푸시 |

<a id="orchestrate"></a>
## 큰 작업 진행

큰 목표를 계획→구현→리뷰→검증 순환으로 끝까지 밀고 감.

| 도구 | 하는 일 |
|---|---|
| `agent_guide` | 큰 요청이 오면 먼저 진행 방법을 안내 |
| `goal_intake` | /goal 같은 큰 목표를 받아 계획으로 정리 |
| `goal_loop` | 탐색→설계→구현→리뷰→검증→복구 역할을 돌며 끝까지 진행. 검증 실패하면 같은 시도 반복 대신 재계획 |
| `mass_ulw_step` | 일을 의존관계 있는 여러 갈래로 나눠 병렬로 구현·검증·수리·리뷰 |
| `mass_ulw_execute` | 승인된 병렬 계획을 웨이브 단위로 실행 |
| `omo_run` | 원할 때만 로컬 OMO 에이전트에 일부 작업 위임 |

<a id="impulse"></a>
## 품질 감시 (Impulse)

진행 중 생긴 사건을 기록해두고, 검증 빠뜨림 같은 비싼 실수를 따로 찾아냄.

| 도구 | 하는 일 |
|---|---|
| `impulse_event_record` | 단계 완료·QA 실패·회귀 같은 사건 기록 |
| `impulse_scout_run` | 기록을 훑어 검증 누락 같은 비싼 실수 찾기 (읽기 전용) |
| `impulse_wake_queue` | 찾아낸 문제 제안 목록 (중요도순) |
| `impulse_director_decide` | 제안을 거절·보류·다음 단계·즉시 처리로 결정 |
| `impulse_director_policy` | 건드리면 안 되는 영역 등 프로젝트 정책 |
| `impulse_semantic_review` | 자동 검사가 못 잡는 품질 문제 보고 |

<a id="image"></a>
## 이미지

ChatGPT에서 만든 이미지를 프로젝트 파일로 바로 저장.

| 도구 | 하는 일 |
|---|---|
| `gpt_image_2_workflow` | ChatGPT로 이미지 만들어서 프로젝트에 저장하는 흐름 안내 |
| `open_chatgpt_images_app` | ChatGPT 이미지 앱 열기 |
| `save_chatgpt_image` | ChatGPT에서 만든 이미지 가져오기 (한 번에) |
| `save_chatgpt_image_from_url` | ChatGPT 이미지 공유 링크로 가져오기 |
| `save_image` | 이미지 데이터 저장 (형식 검사) |
| `save_image_from_clipboard` | 클립보드 이미지 저장 |
| `save_image_from_download` | 방금 다운로드한 이미지 저장 |
| `save_image_from_path` | 로컬 이미지 파일 복사 |
| `save_image_from_url` | 이미지 URL에서 저장 |
| `list_images` | 저장된 이미지 목록 |
| `retrieve_image` | 저장된 이미지 꺼내 보기 |

<a id="desktop"></a>
## 데스크톱 제어 (승인 기반)

화면 조작은 한 동작씩, 주인 승인 후에만. 언제든 즉시 차단 가능.

| 도구 | 하는 일 |
|---|---|
| `computer_screenshot` | 화면이나 앱 창 캡처 (입력은 안 함) |
| `computer_request_action` | 클릭·입력 한 번을 요청. 주인이 승인해야 실행되고, 허용 목록·민감 앱 차단·감사 기록 적용 |
| `computer_action_status` | 요청한 동작의 승인·실행 상태 |
| `computer_kill_switch` | 즉시 데스크톱 제어 전면 차단 |

<a id="ops"></a>
## 운영

JK 자체 관리와 기타 도구.

| 도구 | 하는 일 |
|---|---|
| `executor_restart` | 원격 실행기 재시작 요청 |
| `runtime_upgrade` | JK 자체 업데이트·재시작 |
| `seo_geo_audit` | 공개 웹페이지 SEO/GEO 점검 (내부망 접근 차단 장치 포함) |

이 목록은 `createServer`에 실제로 등록된 도구에서 뽑았습니다. English: [FEATURES.md](FEATURES.md)
