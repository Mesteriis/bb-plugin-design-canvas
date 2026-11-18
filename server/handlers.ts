import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  addComment,
  askForDesign,
  deleteComment,
  deleteDesign,
  editText,
  exportDesign,
  findThread,
  getCover,
  getDesign,
  getDesignVersion,
  importDesign,
  initCanvas,
  listDesigns,
  listHome,
  markCommentsSent,
  moveArtboard,
  moveElement,
  renameDesign,
  saveTweaks,
  sendToThread,
  startDesign,
  threadStatus,
  updateComment,
} from "../shared/rpc";
import { newDesignPrompt } from "../shared/prompts";
import type { Rpc } from "../shared/define";
import * as store from "./store";
import { listWorkspaces, PROJECT_PREFIX, workspaceRoot } from "./workspace";

const DEFINITIONS = [
  listDesigns,
  getDesign,
  getDesignVersion,
  addComment,
  updateComment,
  deleteComment,
  markCommentsSent,
  moveElement,
  moveArtboard,
  renameDesign,
  deleteDesign,
  exportDesign,
  importDesign,
  editText,
  saveTweaks,
  listHome,
  getCover,
  initCanvas,
  startDesign,
  findThread,
  askForDesign,
  sendToThread,
  threadStatus,
] as const;

/** The wire contract for every canvas call; the frontend calls them by `name`. */
export const rpcContract = defineRpcContract(
  Object.fromEntries(DEFINITIONS.map((rpc) => [rpc.name, { input: rpc.input, output: rpc.output }])) as Record<
    string,
    { input: z.ZodType; output: z.ZodType }
  >,
);

type Handler<R extends Rpc> = (input: z.infer<R["input"]>) => Promise<z.infer<R["output"]>> | z.infer<R["output"]>;

export function registerHandlers(bb: BbPluginApi, now: () => number = Date.now): void {
  const handlers = new Map<string, (input: never) => unknown>();
  const handle = <R extends Rpc>(rpc: R, handler: Handler<R>) => {
    handlers.set(rpc.name, handler as unknown as (input: never) => unknown);
  };
  const root = (workspaceId: string) => workspaceRoot(bb, workspaceId);

  handle(listDesigns, async ({ workspaceId }) => {
    const dir = await root(workspaceId);
    const [initialized, slugs, version] = await Promise.all([store.isInitialized(dir), store.listSlugs(dir), store.listVersion(dir)]);
    const designs = await Promise.all(slugs.map((slug) => store.summarize(dir, slug)));
    // Agents read the guide; keep it current when the plugin is updated.
    if (initialized) await store.refreshGuide(dir).catch(() => {});
    return { initialized, designs, version };
  });

  handle(getDesign, async ({ workspaceId, slug }) => store.viewDesign(await root(workspaceId), slug));

  handle(getDesignVersion, async ({ workspaceId, slug }) => ({ version: await store.designVersion(await root(workspaceId), slug) }));

  handle(addComment, async ({ workspaceId, slug, body, anchor }) => ({
    comment: await store.addComment(await root(workspaceId), slug, body, anchor, now()),
  }));

  handle(updateComment, async ({ workspaceId, slug, id, body, status }) => ({
    comment: await store.editComment(await root(workspaceId), slug, id, { body, status }, now()),
  }));

  handle(deleteComment, async ({ workspaceId, slug, id }) => {
    await store.deleteComment(await root(workspaceId), slug, id);
    return {};
  });

  handle(markCommentsSent, async ({ workspaceId, slug, ids }) => {
    await store.markSent(await root(workspaceId), slug, ids, now());
    return {};
  });

  handle(moveElement, async ({ workspaceId, slug, artboardId, dcId, style, expected }) =>
    store.moveElement(await root(workspaceId), slug, artboardId, dcId, style, expected),
  );

  handle(moveArtboard, async ({ workspaceId, slug, artboardId, position }) => {
    await store.moveArtboard(await root(workspaceId), slug, artboardId, position);
    return {};
  });

  handle(renameDesign, async ({ workspaceId, slug, title }) => store.renameDesign(await root(workspaceId), slug, title));

  handle(deleteDesign, async ({ workspaceId, slug }) => store.trashDesign(await root(workspaceId), slug, now()));

  handle(exportDesign, async ({ workspaceId, slug }) => {
    const { fileName, zip } = await store.exportDesign(await root(workspaceId), slug);
    return { fileName, base64: zip.toString("base64") };
  });

  handle(importDesign, async ({ workspaceId, base64 }) => store.importDesign(await root(workspaceId), Buffer.from(base64, "base64")));

  handle(editText, async ({ workspaceId, slug, artboardId, target, before, after, expected }) =>
    store.editText(await root(workspaceId), slug, artboardId, target, before, after, expected),
  );

  handle(saveTweaks, async ({ workspaceId, slug, values }) => store.saveTweaks(await root(workspaceId), slug, values));

  handle(listHome, async () => {
    const workspaces = await listWorkspaces(bb);
    const projects = await Promise.all(
      workspaces.map(async (workspace) => {
        const dir = workspace.directory;
        const [slugs, agents]: [string[], Record<string, string>] = (await store.isInitialized(dir))
          ? await Promise.all([store.listSlugs(dir), store.readDesignAgents(dir)])
          : [[], {}];
        const designs = await Promise.all(
          slugs.map(async (slug) => ({
            ...(await store.summarize(dir, slug)),
            updatedAt: await store.designUpdatedAt(dir, slug),
            agentId: agents[slug] ?? null,
          })),
        );
        return { workspaceId: workspace.id, directory: dir, project: workspace.project, workspace: workspace.name, designs };
      }),
    );
    // bb gives every personal thread its own workspace: list those with designs, and one per project to design in.
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace.projectId]));
    const firstOfProject = new Set<string>();
    return {
      projects: projects.filter((project) => {
        const projectId = byId.get(project.workspaceId) ?? project.project;
        const first = !firstOfProject.has(projectId);
        firstOfProject.add(projectId);
        return project.designs.length > 0 || first;
      }),
    };
  });

  handle(getCover, async ({ workspaceId, slug }) => ({ cover: await store.coverView(await root(workspaceId), slug) }));

  handle(initCanvas, async ({ workspaceId }) => ({ created: await store.initCanvas(await root(workspaceId)) }));

  // What paseo does with agents, bb does with threads. Every one is bound to the workspace it names:
  // a thread must belong to that workspace's environment, which must be on this machine.
  /** The folder a thread works in, to tell whether it belongs to a workspace. */
  async function threadFolder(threadId: string): Promise<string | null> {
    const environmentId = (await bb.sdk.threads.get({ threadId })).environmentId;
    return environmentId ? ((await bb.sdk.environments.get({ environmentId })).path ?? null) : null;
  }

  async function ownThread(workspaceId: string, threadId: string): Promise<void> {
    const folder = await root(workspaceId);
    if ((await threadFolder(threadId)) !== folder) throw new Error("That thread does not work in this workspace.");
  }

  /** Starts a thread in the workspace: in its environment, or in the project's default one. */
  async function spawnIn(workspaceId: string, title: string, prompt: string) {
    const project = workspaceId.startsWith(PROJECT_PREFIX);
    const projectId = project ? workspaceId.slice(PROJECT_PREFIX.length) : (await bb.sdk.environments.get({ environmentId: workspaceId })).projectId;
    return bb.sdk.threads.spawn({
      projectId,
      environment: project ? { type: "project-default" } : { type: "reuse", environmentId: workspaceId },
      title,
      prompt,
      // Marks the thread as a canvas thread, so it gets the design tools from its first turn.
      pluginMetadata: { enabled: true },
    });
  }

  handle(startDesign, async ({ workspaceId, kind, brief }) => {
    await store.initCanvas(await root(workspaceId));
    const thread = await spawnIn(workspaceId, oneLine(brief, 60), newDesignPrompt(brief, kind));
    return { threadId: thread.id };
  });

  /** The thread to open a design with: the one that made it, else the latest thread in the workspace. */
  handle(findThread, async ({ workspaceId, preferred, create }) => {
    await root(workspaceId);
    const folder = await root(workspaceId);
    const listed = workspaceId.startsWith(PROJECT_PREFIX)
      ? await bb.sdk.threads.list({ projectId: workspaceId.slice(PROJECT_PREFIX.length), archived: false, limit: 200 })
      : await bb.sdk.threads.list({ environmentId: workspaceId, archived: false, limit: 200 });
    // Threads of a project can work in other folders (worktrees): keep the ones working in this one.
    const threads: typeof listed = [];
    for (const thread of listed.slice(0, 40)) if ((await threadFolder(thread.id)) === folder) threads.push(thread);
    const found = threads.find((thread) => thread.id === preferred) ?? threads[0];
    if (found) return { threadId: found.id };
    if (!create) return { threadId: null };
    const thread = await spawnIn(workspaceId, "Design canvas", "The Design canvas is open in this workspace. Reply \"Ready\" and wait for the user's design requests.");
    return { threadId: thread.id };
  });

  handle(askForDesign, async ({ workspaceId, threadId, brief }) => {
    await ownThread(workspaceId, threadId);
    await store.initCanvas(await root(workspaceId));
    await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: newDesignPrompt(brief), mentions: [] }] });
    return {};
  });

  handle(sendToThread, async ({ workspaceId, threadId, text }) => {
    await ownThread(workspaceId, threadId);
    await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    return {};
  });

  handle(threadStatus, async ({ workspaceId, threadId }) => {
    await ownThread(workspaceId, threadId);
    return { status: (await bb.sdk.threads.get({ threadId })).status ?? null };
  });

  const wire: Record<string, (input: never) => unknown> = Object.fromEntries(handlers);
  bb.rpc.register(rpcContract, wire as never);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
