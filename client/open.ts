import type { DesignKind } from "../shared/design";
import { startDesign } from "../shared/rpc";
import type { Call } from "./rpc";

/** What a Design tab should show when it opens, or right away if it is already open. */
export type Handoff = { kind: "design"; slug: string } | { kind: "new"; known: string[] };

const pending = new Map<string, Handoff>();
const listeners = new Map<string, Set<(handoff: Handoff) => void>>();

/** Passes a design to a thread's Design tab: to the open one, else to the next one that mounts. */
export function handOff(threadId: string, handoff: Handoff): void {
  const open = listeners.get(threadId);
  if (open?.size) {
    for (const listener of open) listener(handoff);
    return;
  }
  pending.set(threadId, handoff);
}

export function takeHandoff(threadId: string): Handoff | undefined {
  const handoff = pending.get(threadId);
  pending.delete(threadId);
  return handoff;
}

export function listenHandoff(threadId: string, listener: (handoff: Handoff) => void): () => void {
  const set = listeners.get(threadId) ?? new Set();
  set.add(listener);
  listeners.set(threadId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export const TAB_ID = "design";
export const OPEN_TAB_EVENT = "design-canvas:open-tab";
export const OPEN_HOME_EVENT = "design-canvas:open-home";

/** Asks the app overlay to show a thread's Design tab once the thread is on screen. */
export function showDesignTab(threadId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: threadId }));
}

export interface Navigation {
  toThread(threadId: string): void;
  toPluginPanel(path: string, options?: { subPath?: string }): void;
}

/** The page that shows a design at full size, with no thread needed to look at it. */
export function designPath(workspaceId: string, slug: string): string {
  return `${workspaceId}/${slug}`;
}

/** Opens a design on its own page; a thread is found or started only when the user sends something. */
export function openDesign(input: { nav: Navigation; workspaceId: string; slug: string }): void {
  input.nav.toPluginPanel("design", { subPath: designPath(input.workspaceId, input.slug) });
}

/** Starts a thread on a new design in the workspace and shows its chat and canvas. */
export async function createDesign(input: {
  call: Call;
  nav: Navigation;
  workspaceId: string;
  /** The designs the workspace has now, so the canvas can tell the new one. */
  known: string[];
  kind: DesignKind;
  brief: string;
}): Promise<void> {
  const { threadId } = await input.call(startDesign, { workspaceId: input.workspaceId, kind: input.kind, brief: input.brief });
  handOff(threadId, { kind: "new", known: input.known });
  input.nav.toThread(threadId);
  showDesignTab(threadId);
}
