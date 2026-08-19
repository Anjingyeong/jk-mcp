import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type LeasePreset, type ToolContext } from "../types.js";
import { findProject } from "../workspace/registry.js";

export const ROLE_TOOL_VALUES = [
  "code_search",
  "file_read",
  "tests",
  "file_write",
  "git",
  "browser",
] as const;

export const WORKFLOW_PRESETS = [
  { id: "implementation", name: "Implementation", preference: "Implement the smallest coherent slice, verify it, then fix only evidence-backed issues." },
  { id: "review", name: "Review", preference: "Inspect evidence first and return prioritized findings with file/line evidence; do not modify the project." },
  { id: "qa", name: "QA / E2E", preference: "Reproduce first, capture evidence, run targeted tests/E2E, and report the smallest reproducible failure." },
  { id: "research", name: "Research", preference: "Collect evidence, compare alternatives, and make uncertainty explicit before recommending a direction." },
  { id: "planning", name: "Planning", preference: "Inspect the current architecture, choose the smallest viable design, and order work by dependencies and verification risk." },
] as const;

export type RoleTool = (typeof ROLE_TOOL_VALUES)[number];
export type RolePermissionPreset = "inherit" | "read-only" | "tests-only" | "full-write" | "image-only";

export interface JkRole {
  id: string;
  name: string;
  description: string;
  instructions: string;
  permissionPreset: RolePermissionPreset;
  tools: RoleTool[];
  skills: string[];
  workflowPreference: string;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RoleState {
  version: 1;
  updatedAt: number;
  customRoles: JkRole[];
  activeByProject: Record<string, string>;
  activeSourceByProject: Record<string, "manual" | "auto">;
  defaultByProject: Record<string, string>;
}

export interface ActiveRoleContext {
  projectId: string;
  projectName: string;
  role: JkRole;
  defaultRoleId: string | null;
  selectionSource: "auto" | "last-used" | "project-default" | "global-default";
  projectPermission: LeasePreset | null;
  rolePermission: RolePermissionPreset;
  effectivePermission: LeasePreset | null;
  contextText: string;
}

const RoleToolSchema = z.enum(ROLE_TOOL_VALUES);
const RolePermissionSchema = z.enum(["inherit", "read-only", "tests-only", "full-write", "image-only"]);
const RoleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().max(12_000),
  permissionPreset: RolePermissionSchema,
  tools: z.array(RoleToolSchema).max(ROLE_TOOL_VALUES.length),
  skills: z.array(z.string().min(1).max(80)).max(30),
  workflowPreference: z.string().max(1000),
  builtIn: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
const RoleStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  customRoles: z.array(RoleSchema),
  activeByProject: z.record(z.string(), z.string()),
  activeSourceByProject: z.record(z.string(), z.enum(["manual", "auto"])).default({}),
  defaultByProject: z.record(z.string(), z.string()).default({}),
});

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ROLES_FILE = "roles.json";

function builtInRole(
  id: string,
  name: string,
  description: string,
  instructions: string,
  permissionPreset: RolePermissionPreset,
  tools: RoleTool[],
  skills: string[],
  workflowPreference: string,
): JkRole {
  return {
    id,
    name,
    description,
    instructions,
    permissionPreset,
    tools,
    skills,
    workflowPreference,
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

export const BUILT_IN_ROLES: readonly JkRole[] = [
  builtInRole(
    "default",
    "Default",
    "기존 JK 동작을 그대로 사용",
    "기존 프로젝트 규칙과 사용자의 현재 요청을 우선한다.",
    "inherit",
    [...ROLE_TOOL_VALUES],
    [],
    "Use the existing JK workflow without additional role-specific restrictions.",
  ),
  builtInRole(
    "builder",
    "Builder",
    "구현 → 테스트 → 수정",
    "요구사항을 작은 변경으로 구현하고, 가장 가까운 테스트로 검증한 뒤 필요한 수정까지 완료한다. 불필요한 리팩터링은 하지 않는다.",
    "full-write",
    ["code_search", "file_read", "tests", "file_write", "git", "browser"],
    ["Implementation", "Debugging", "Testing"],
    "Implement the smallest coherent slice, verify it, then fix only evidence-backed issues.",
  ),
  builtInRole(
    "reviewer",
    "Reviewer",
    "코드 리뷰 / 문제 분석",
    "운영환경 기준으로 검토한다. 장애 가능성을 우선하고 보안 → 동시성 → DB → 성능 순으로 본다. 직접 수정하거나 불필요한 리팩터링을 하지 않는다.",
    "read-only",
    ["code_search", "file_read"],
    ["Backend", "Security", "Review"],
    "Inspect evidence first and return prioritized findings with file/line evidence; do not modify the project.",
  ),
  builtInRole(
    "qa-engineer",
    "QA Engineer",
    "재현 / 테스트 / E2E",
    "사용자 흐름을 우선 검증한다. 문제를 먼저 재현하고 재현 증거를 확보한다. 테스트와 E2E는 실행하되 직접 소스 코드를 수정하지 않는다.",
    "tests-only",
    ["code_search", "file_read", "tests", "browser"],
    ["QA", "E2E", "Web"],
    "Reproduce first, capture evidence, run targeted tests/E2E, and report the smallest reproducible failure.",
  ),
  builtInRole(
    "researcher",
    "Researcher",
    "자료 조사 / 비교 / 근거 확인",
    "주장을 근거와 분리하고, 확인 가능한 자료를 우선한다. 프로젝트 파일은 읽기만 하며 구현 변경은 하지 않는다.",
    "read-only",
    ["code_search", "file_read", "browser"],
    ["Research", "Comparison", "Evidence"],
    "Collect evidence, compare alternatives, and make uncertainty explicit before recommending a direction.",
  ),
  builtInRole(
    "planner",
    "Planner",
    "아키텍처 / 구현 계획",
    "현재 구조와 제약을 먼저 확인한 뒤 과도한 설계를 피하고, 의존성과 검증 순서가 드러나는 구현 계획을 만든다. 직접 수정하지 않는다.",
    "read-only",
    ["code_search", "file_read"],
    ["Architecture", "Planning"],
    "Inspect the current architecture, choose the smallest viable design, and order work by dependencies and verification risk.",
  ),
] as const;

const BUILT_IN_BY_ID = new Map(BUILT_IN_ROLES.map((role) => [role.id, role]));

function emptyRoleState(): RoleState {
  return {
    version: 1,
    updatedAt: Date.now(),
    customRoles: [],
    activeByProject: {},
    activeSourceByProject: {},
    defaultByProject: {},
  };
}

function roleStatePath(stateDir: string): string {
  return path.join(stateDir, ROLES_FILE);
}

async function readRoleState(stateDir: string): Promise<RoleState> {
  try {
    const raw = await readFile(roleStatePath(stateDir), "utf8");
    const parsed = RoleStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Role store validation failed: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRoleState();
    if (err instanceof DomainError) throw err;
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Role store read failed: ${(err as Error).message}`);
  }
}

async function writeRoleState(stateDir: string, state: RoleState): Promise<RoleState> {
  const validated = RoleStateSchema.parse({ ...state, version: 1, updatedAt: Date.now() });
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const target = roleStatePath(stateDir);
  const tmp = path.join(stateDir, `.${ROLES_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(validated, null, 2), { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, target);
  return validated;
}

export async function listRoles(stateDir: string): Promise<JkRole[]> {
  const state = await readRoleState(stateDir);
  return [...BUILT_IN_ROLES, ...state.customRoles];
}

export async function getRole(stateDir: string, roleId: string): Promise<JkRole | null> {
  const builtIn = BUILT_IN_BY_ID.get(roleId);
  if (builtIn) return builtIn;
  const state = await readRoleState(stateDir);
  return state.customRoles.find((role) => role.id === roleId) ?? null;
}

export interface SaveRoleInput {
  id?: string;
  name: string;
  description?: string;
  instructions?: string;
  permissionPreset: RolePermissionPreset;
  tools?: RoleTool[];
  skills?: string[];
  workflowPreference?: string;
}

export async function saveCustomRole(stateDir: string, input: SaveRoleInput): Promise<JkRole> {
  const state = await readRoleState(stateDir);
  const id = input.id?.trim() || `custom-${randomUUID()}`;
  if (BUILT_IN_BY_ID.has(id)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Built-in roles cannot be edited; duplicate the role instead.", { roleId: id });
  }
  const existingIndex = state.customRoles.findIndex((role) => role.id === id);
  const existing = existingIndex >= 0 ? state.customRoles[existingIndex] : undefined;
  const now = Date.now();
  const role = RoleSchema.parse({
    id,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    instructions: input.instructions?.trim() ?? "",
    permissionPreset: input.permissionPreset,
    tools: Array.from(new Set(input.tools ?? [])),
    skills: Array.from(new Set((input.skills ?? []).map((skill) => skill.trim()).filter(Boolean))),
    workflowPreference: input.workflowPreference?.trim() ?? "",
    builtIn: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (existingIndex >= 0) state.customRoles[existingIndex] = role;
  else state.customRoles.push(role);
  await writeRoleState(stateDir, state);
  return role;
}

export async function selectRoleForProject(stateDir: string, projectId: string, roleId: string): Promise<JkRole> {
  const role = await getRole(stateDir, roleId);
  if (!role) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Role not found: ${roleId}`, { roleId });
  const state = await readRoleState(stateDir);
  state.activeByProject[projectId] = role.id;
  state.activeSourceByProject[projectId] = "manual";
  await writeRoleState(stateDir, state);
  return role;
}

export type RoleTaskMode = "implement" | "research" | "debug" | "review" | "plan";

function inferredBuiltInRoleId(mode: RoleTaskMode, goal?: string): string {
  if (mode === "review") return "reviewer";
  if (mode === "research") return "researcher";
  if (mode === "plan") return "planner";
  if (mode === "debug") return "builder";

  const text = goal?.trim() ?? "";
  const qaIntent = /(^|\s)(qa|e2e)(\s|$)|(?:테스트|검증|재현)(?:해|해줘|만|부터|진행)/i.test(text);
  const writeIntent = /구현|수정|고쳐|만들|추가|변경|패치|implement|build|fix|edit|change/i.test(text);
  return qaIntent && !writeIntent ? "qa-engineer" : "builder";
}

export async function autoSelectRoleForTask(
  ctx: ToolContext,
  projectRef: string,
  input: { mode: RoleTaskMode; goal?: string },
): Promise<{ projectId: string; role: JkRole; source: "auto" | "manual" | "project-default" }> {
  const projectId = await resolveCanonicalRoleProjectId(ctx, projectRef);
  const state = await readRoleState(ctx.stateDir);
  const activeRoleId = state.activeByProject[projectId];
  const activeRole = activeRoleId
    ? BUILT_IN_BY_ID.get(activeRoleId) ?? state.customRoles.find((candidate) => candidate.id === activeRoleId)
    : undefined;
  const activeSource = state.activeSourceByProject[projectId];

  // A role explicitly chosen after auto-routing was introduced is a hard
  // override. Legacy custom-role selections are also treated as intentional.
  if (activeRole && (activeSource === "manual" || (!activeSource && !activeRole.builtIn))) {
    return { projectId, role: activeRole, source: "manual" };
  }

  const defaultRoleId = state.defaultByProject[projectId];
  const defaultRole = defaultRoleId
    ? BUILT_IN_BY_ID.get(defaultRoleId) ?? state.customRoles.find((candidate) => candidate.id === defaultRoleId)
    : undefined;
  if (defaultRole) {
    delete state.activeByProject[projectId];
    delete state.activeSourceByProject[projectId];
    await writeRoleState(ctx.stateDir, state);
    return { projectId, role: defaultRole, source: "project-default" };
  }

  const roleId = inferredBuiltInRoleId(input.mode, input.goal);
  const role = BUILT_IN_BY_ID.get(roleId) ?? BUILT_IN_BY_ID.get("default")!;
  if (activeRoleId !== role.id || activeSource !== "auto") {
    state.activeByProject[projectId] = role.id;
    state.activeSourceByProject[projectId] = "auto";
    await writeRoleState(ctx.stateDir, state);
  }
  return { projectId, role, source: "auto" };
}

export async function setDefaultRoleForProject(stateDir: string, projectId: string, roleId: string): Promise<JkRole> {
  const role = await getRole(stateDir, roleId);
  if (!role) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Role not found: ${roleId}`, { roleId });
  const state = await readRoleState(stateDir);
  state.defaultByProject[projectId] = role.id;
  await writeRoleState(stateDir, state);
  return role;
}

export async function deleteCustomRole(stateDir: string, roleId: string): Promise<boolean> {
  if (BUILT_IN_BY_ID.has(roleId)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Built-in roles cannot be deleted.", { roleId });
  }
  const state = await readRoleState(stateDir);
  const index = state.customRoles.findIndex((role) => role.id === roleId);
  if (index < 0) return false;
  state.customRoles.splice(index, 1);
  for (const mapping of [state.activeByProject, state.defaultByProject]) {
    for (const [projectId, selectedRoleId] of Object.entries(mapping)) {
      if (selectedRoleId === roleId) delete mapping[projectId];
    }
  }
  for (const projectId of Object.keys(state.activeSourceByProject)) {
    if (!state.activeByProject[projectId]) delete state.activeSourceByProject[projectId];
  }
  await writeRoleState(stateDir, state);
  return true;
}

export interface RoleBundle {
  format: "jk-roles";
  version: 1;
  exportedAt: number;
  roles: JkRole[];
}

const RoleBundleSchema = z.object({
  format: z.literal("jk-roles"),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative().optional(),
  roles: z.array(RoleSchema).max(100),
});

export async function exportRoleBundle(stateDir: string): Promise<RoleBundle> {
  const state = await readRoleState(stateDir);
  return { format: "jk-roles", version: 1, exportedAt: Date.now(), roles: state.customRoles };
}

export async function importRoleBundle(stateDir: string, input: unknown): Promise<{ imported: number; roles: JkRole[] }> {
  const bundle = RoleBundleSchema.parse(input);
  const state = await readRoleState(stateDir);
  const imported: JkRole[] = [];
  const now = Date.now();
  for (const candidate of bundle.roles) {
    if (candidate.builtIn || BUILT_IN_BY_ID.has(candidate.id)) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Role bundles cannot replace built-in roles.", { roleId: candidate.id });
    }
    const existingIndex = state.customRoles.findIndex((role) => role.id === candidate.id);
    const role = RoleSchema.parse({ ...candidate, builtIn: false, updatedAt: now });
    if (existingIndex >= 0) state.customRoles[existingIndex] = role;
    else state.customRoles.push(role);
    imported.push(role);
  }
  await writeRoleState(stateDir, state);
  return { imported: imported.length, roles: imported };
}

export async function getActiveRoleForProject(stateDir: string, projectId: string): Promise<JkRole> {
  const state = await readRoleState(stateDir);
  const selectedId = state.activeByProject[projectId] ?? state.defaultByProject[projectId] ?? "default";
  const role = BUILT_IN_BY_ID.get(selectedId) ?? state.customRoles.find((candidate) => candidate.id === selectedId);
  return role ?? BUILT_IN_BY_ID.get("default")!;
}

export async function resolveCanonicalRoleProjectId(ctx: ToolContext, projectRef: string): Promise<string> {
  let entries = ctx.registry;
  if (entries.length === 0 && typeof ctx.store.loadProjects === "function") {
    entries = await ctx.store.loadProjects();
  }
  const exact = findProject(entries, { projectId: projectRef });
  if (exact.ok) return exact.entry.projectId;
  const byName = findProject(entries, { name: projectRef });
  if (byName.ok) return byName.entry.projectId;

  const normalizedRef = projectRef.trim().toLowerCase().replace(/[\s_-]+/g, "-");
  const prefixMatches = entries.filter((entry) =>
    [entry.projectId, entry.name, ...entry.aliases]
      .map((value) => value.trim().toLowerCase().replace(/[\s_-]+/g, "-"))
      .some((value) => value.startsWith(`${normalizedRef}-`)),
  );
  return prefixMatches.length === 1 ? prefixMatches[0]!.projectId : projectRef;
}

export async function getActiveRoleForProjectContext(
  ctx: ToolContext,
  projectRef: string,
): Promise<{ projectId: string; role: JkRole }> {
  const projectId = await resolveCanonicalRoleProjectId(ctx, projectRef);
  const state = await readRoleState(ctx.stateDir);
  let selectedId = state.activeByProject[projectId];
  let defaultRoleId = state.defaultByProject[projectId];
  let changed = false;

  if (!selectedId) {
    const legacyKeys = [projectRef, ...Object.keys(state.activeByProject)].filter(
      (value, index, values) => value !== projectId && values.indexOf(value) === index,
    );
    for (const legacyKey of legacyKeys) {
      const legacyRoleId = state.activeByProject[legacyKey];
      if (!legacyRoleId) continue;
      if ((await resolveCanonicalRoleProjectId(ctx, legacyKey)) === projectId) {
        selectedId = legacyRoleId;
        state.activeByProject[projectId] = legacyRoleId;
        if (state.activeSourceByProject[legacyKey]) {
          state.activeSourceByProject[projectId] = state.activeSourceByProject[legacyKey]!;
        }
        changed = true;
        break;
      }
    }
  }

  for (const legacyKey of Object.keys(state.activeByProject)) {
    if (legacyKey === projectId) continue;
    if ((await resolveCanonicalRoleProjectId(ctx, legacyKey)) === projectId) {
      delete state.activeByProject[legacyKey];
      delete state.activeSourceByProject[legacyKey];
      changed = true;
    }
  }
  if (!defaultRoleId) {
    const legacyKeys = [projectRef, ...Object.keys(state.defaultByProject)].filter(
      (value, index, values) => value !== projectId && values.indexOf(value) === index,
    );
    for (const legacyKey of legacyKeys) {
      const legacyRoleId = state.defaultByProject[legacyKey];
      if (!legacyRoleId) continue;
      if ((await resolveCanonicalRoleProjectId(ctx, legacyKey)) === projectId) {
        defaultRoleId = legacyRoleId;
        state.defaultByProject[projectId] = legacyRoleId;
        changed = true;
        break;
      }
    }
  }
  for (const legacyKey of Object.keys(state.defaultByProject)) {
    if (legacyKey === projectId) continue;
    if ((await resolveCanonicalRoleProjectId(ctx, legacyKey)) === projectId) {
      delete state.defaultByProject[legacyKey];
      changed = true;
    }
  }
  if (changed) await writeRoleState(ctx.stateDir, state);

  const roleId = selectedId ?? defaultRoleId ?? "default";
  const role = BUILT_IN_BY_ID.get(roleId) ?? state.customRoles.find((candidate) => candidate.id === roleId);
  return { projectId, role: role ?? BUILT_IN_BY_ID.get("default")! };
}

const CAPABILITIES: Record<LeasePreset, readonly string[]> = {
  "read-only": ["read"],
  "tests-only": ["read", "verify"],
  "full-write": ["read", "verify", "write", "image", "remote"],
  "image-only": ["read", "image"],
  control: ["read", "control"],
};

function roleCapabilities(preset: RolePermissionPreset): ReadonlySet<string> | null {
  if (preset === "inherit") return null;
  return new Set(CAPABILITIES[preset]);
}

export function roleAllowsCapability(rolePreset: RolePermissionPreset, capability: string): boolean {
  const allowed = roleCapabilities(rolePreset);
  return allowed === null || allowed.has(capability);
}

export function computeEffectivePermission(
  projectPreset: LeasePreset,
  rolePreset: RolePermissionPreset,
): LeasePreset {
  if (rolePreset === "inherit") return projectPreset;
  const project = new Set(CAPABILITIES[projectPreset]);
  const role = new Set(CAPABILITIES[rolePreset]);
  const intersection = new Set([...project].filter((capability) => role.has(capability)));
  const candidates: LeasePreset[] = ["full-write", "tests-only", "image-only", "control", "read-only"];
  for (const candidate of candidates) {
    const capabilities = CAPABILITIES[candidate];
    if (capabilities.length === intersection.size && capabilities.every((capability) => intersection.has(capability))) {
      return candidate;
    }
  }
  return "read-only";
}

const ROLE_TOOL_BY_MCP_TOOL: Readonly<Record<string, RoleTool>> = {
  code_search: "code_search",
  code_context_pack: "code_search",
  analysis_cache_get: "file_read",
  analysis_cache_put: "file_read",
  known_fix_search: "file_read",
  known_fix_add: "file_read",
  project_rules: "file_read",
  project_status: "file_read",
  repo_status: "file_read",
  repo_diff_summary: "file_read",
  git_status: "file_read",
  git_diff_summary: "file_read",
  file_read_slice: "file_read",
  checkpoint_list: "file_read",
  checkpoint_show: "file_read",
  list_images: "file_read",
  retrieve_image: "file_read",
  command_list: "tests",
  command_run: "tests",
  local_shell_run: "tests",
  e2e_start_server: "tests",
  e2e_run_command: "tests",
  e2e_test_and_show_screenshot: "tests",
  e2e_screenshot: "tests",
  e2e_open_target: "browser",
  e2e_open_url_screenshot: "browser",
  file_apply_patch: "file_write",
  file_create: "file_write",
  checkpoint_restore: "file_write",
  save_image: "file_write",
  save_chatgpt_image: "file_write",
  save_chatgpt_image_from_url: "file_write",
  save_image_from_url: "file_write",
  save_image_from_clipboard: "file_write",
  save_image_from_download: "file_write",
  save_image_from_path: "file_write",
  git_commit: "git",
  git_push: "git",
};

function projectIdFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const candidate = (input as { projectId?: unknown }).projectId;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export async function enforceActiveRoleToolAccess(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
): Promise<void> {
  const requiredTool = ROLE_TOOL_BY_MCP_TOOL[toolName];
  if (!requiredTool) return;
  let projectId = projectIdFromToolInput(input);
  if (!projectId) {
    const session = await ctx.store.getSession();
    if (session && typeof session === "object") {
      const active = (session as { activeProjectId?: unknown }).activeProjectId;
      if (typeof active === "string") projectId = active;
    }
  }
  if (!projectId) return;
  const active = await getActiveRoleForProjectContext(ctx, projectId);
  projectId = active.projectId;
  const role = active.role;
  if (!role.tools.includes(requiredTool)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Role ${role.name} does not allow ${requiredTool}`, {
      projectId,
      roleId: role.id,
      role: role.name,
      requiredTool,
      toolName,
    });
  }
}

export async function buildActiveRoleContext(
  ctx: ToolContext,
  projectId: string,
  projectPreset?: LeasePreset | null,
): Promise<ActiveRoleContext> {
  const active = await getActiveRoleForProjectContext(ctx, projectId);
  projectId = active.projectId;
  const role = active.role;
  const state = await readRoleState(ctx.stateDir);
  const selectedRoleId = state.activeByProject[projectId] ?? null;
  const defaultRoleId = state.defaultByProject[projectId] ?? null;
  const selectedRole = selectedRoleId
    ? BUILT_IN_BY_ID.get(selectedRoleId) ?? state.customRoles.find((candidate) => candidate.id === selectedRoleId)
    : undefined;
  const selectionSource: ActiveRoleContext["selectionSource"] = selectedRoleId
    ? state.activeSourceByProject[projectId] === "auto" || (!state.activeSourceByProject[projectId] && selectedRole?.builtIn)
      ? "auto"
      : "last-used"
    : defaultRoleId
      ? "project-default"
      : "global-default";
  let resolvedProjectPreset = projectPreset ?? null;
  if (!resolvedProjectPreset) {
    const session = await ctx.store.getSession();
    if (session && typeof session === "object") {
      const lease = (session as { lease?: { projectId?: unknown; preset?: unknown } | null }).lease;
      if (lease?.projectId === projectId && typeof lease.preset === "string") {
        resolvedProjectPreset = lease.preset as LeasePreset;
      }
    }
  }
  const project = ctx.registry.find((entry) => entry.projectId === projectId);
  const projectName = project?.name ?? projectId;
  const effectivePermission = resolvedProjectPreset
    ? computeEffectivePermission(resolvedProjectPreset, role.permissionPreset)
    : null;
  const instructions = role.instructions.trim() || "(none)";
  const contextText = [
    "ACTIVE PROJECT",
    projectName,
    "",
    "ACTIVE ROLE",
    role.name,
    "",
    "ROLE INSTRUCTIONS",
    instructions,
    "",
    "ROLE TOOLS",
    role.tools.join(" · ") || "(none)",
    "",
    "ROLE SKILLS",
    role.skills.join(" · ") || "(none)",
    "",
    "WORKFLOW PREFERENCE",
    role.workflowPreference || "(default)",
    "",
    "PROJECT PERMISSION",
    resolvedProjectPreset ?? "(no active lease)",
    "",
    "EFFECTIVE PERMISSION",
    effectivePermission ?? "(no active lease)",
  ].join("\n");
  return {
    projectId,
    projectName,
    role,
    defaultRoleId,
    selectionSource,
    projectPermission: resolvedProjectPreset,
    rolePermission: role.permissionPreset,
    effectivePermission,
    contextText,
  };
}
