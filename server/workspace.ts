import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The canvas's workspace is a folder where design/ lives. An environment is one: its id is the
 * workspace id. A project with no environment yet is one too, as `project:<id>`, at its local
 * folder. The store reads the folder directly, so only folders on this server's machine can be used.
 */
export const PROJECT_PREFIX = "project:";
export interface WorkspaceEntry {
  id: string;
  directory: string;
  project: string;
  projectId: string;
  name: string;
  updatedAt: number;
}

async function localHostId(bb: BbPluginApi): Promise<string> {
  const id = (await bb.sdk.system.config()).primaryHostId;
  if (!id) throw new Error("This bb server has no local host.");
  return id;
}

/** The local folder of a project, from its default source on this machine. */
async function projectFolder(bb: BbPluginApi, projectId: string): Promise<string> {
  const host = await localHostId(bb);
  const project = (await bb.sdk.projects.list()).find((candidate) => candidate.id === projectId);
  const sources = (project?.sources ?? []).filter((source) => source.type === "local_path" && source.hostId === host && source.path);
  const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
  if (!source?.path) throw new Error("This project has no folder on this machine.");
  return source.path;
}

export async function workspaceRoot(bb: BbPluginApi, workspaceId: string): Promise<string> {
  if (workspaceId.startsWith(PROJECT_PREFIX)) return projectFolder(bb, workspaceId.slice(PROJECT_PREFIX.length));
  const env = await bb.sdk.environments.get({ environmentId: workspaceId });
  if (!env.path) throw new Error(`Workspace ${workspaceId} has no folder`);
  if (env.hostId !== (await localHostId(bb))) throw new Error("The design canvas works on workspaces on this machine only.");
  return env.path;
}

/** The workspace a thread works in. */
export async function threadWorkspace(bb: BbPluginApi, threadId: string): Promise<{ id: string; root: string }> {
  const thread = (await bb.sdk.threads.get({ threadId })) as { environmentId?: string | null };
  if (!thread.environmentId) throw new Error("This thread has no workspace.");
  return { id: thread.environmentId, root: await workspaceRoot(bb, thread.environmentId) };
}

/** The workspaces on this machine that can hold designs, most recently active first. */
export async function listWorkspaces(bb: BbPluginApi): Promise<WorkspaceEntry[]> {
  const [envs, projects, host] = await Promise.all([bb.sdk.environments.list(), bb.sdk.projects.list(), localHostId(bb)]);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const seen = new Set<string>();
  const out: WorkspaceEntry[] = [];
  for (const env of [...envs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (env.hostId !== host || !env.path || env.status !== "ready" || seen.has(env.path)) continue;
    seen.add(env.path);
    out.push({
      id: env.id,
      directory: env.path,
      projectId: env.projectId,
      project: names.get(env.projectId) ?? (env.projectId === "proj_personal" ? "Personal" : env.projectId),
      name: env.name ?? env.branchName ?? names.get(env.projectId) ?? (env.projectId === "proj_personal" ? "Personal" : env.id),
      updatedAt: env.updatedAt,
    });
  }
  // A project nobody has opened has no environment yet, but its folder can hold designs all the same.
  for (const project of projects) {
    for (const source of project.sources ?? []) {
      if (source.type !== "local_path" || source.hostId !== host || !source.path || seen.has(source.path)) continue;
      seen.add(source.path);
      out.push({ id: `${PROJECT_PREFIX}${project.id}`, directory: source.path, projectId: project.id, project: project.name, name: project.name, updatedAt: project.updatedAt });
    }
  }
  return out;
}
