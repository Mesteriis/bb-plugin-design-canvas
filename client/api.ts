import {
  addComment,
  askForDesign,
  deleteComment,
  deleteDesign,
  editText,
  exportDesign,
  getDesign,
  getDesignVersion,
  importDesign,
  listDesigns,
  markCommentsSent,
  moveArtboard,
  moveElement,
  renameDesign,
  saveTweaks,
  sendToThread,
  updateComment,
} from "../shared/rpc";
import type { AgentStatus, CanvasApi } from "./canvas";
import { pickZip } from "./files";
import type { Call } from "./rpc";

/** bb thread statuses as the canvas knows them. */
export function agentStatus(status: string | null): AgentStatus {
  if (status === null) return null;
  if (status === "active") return "running";
  if (status === "error") return "error";
  if (status === "idle") return "idle";
  // Starting, stopping, pending and the like: the thread cannot take a message yet.
  return "initializing";
}

/**
 * What the canvas needs from bb, over the plugin's RPCs. `thread` finds the thread that messages go to;
 * on a design opened from the home page there may be none until the first message.
 */
export function canvasApi(c: Call, workspaceId: string, thread: () => Promise<string>): CanvasApi {
  return {
    listDesigns: () => c(listDesigns, { workspaceId }),
    getDesign: (slug) => c(getDesign, { workspaceId, slug }),
    getDesignVersion: async (slug) => (await c(getDesignVersion, { workspaceId, slug })).version,
    addComment: async (slug, body, anchor) => (await c(addComment, { workspaceId, slug, body, anchor })).comment,
    updateComment: async (slug, id, patch) => (await c(updateComment, { workspaceId, slug, id, ...patch })).comment,
    deleteComment: async (slug, id) => {
      await c(deleteComment, { workspaceId, slug, id });
    },
    markSent: async (slug, ids) => {
      await c(markCommentsSent, { workspaceId, slug, ids });
    },
    moveElement: (slug, artboardId, dcId, style, expected) => c(moveElement, { workspaceId, slug, artboardId, dcId, style, expected }),
    editText: (slug, artboardId, target, before, after, expected) => c(editText, { workspaceId, slug, artboardId, target, before, after, expected }),
    renameDesign: async (slug, title) => {
      await c(renameDesign, { workspaceId, slug, title });
    },
    exportDesign: (slug) => c(exportDesign, { workspaceId, slug }),
    importDesign: (base64) => c(importDesign, { workspaceId, base64 }),
    pickZip,
    deleteDesign: async (slug) => (await c(deleteDesign, { workspaceId, slug })).trashedTo,
    saveTweaks: (slug, values) => c(saveTweaks, { workspaceId, slug, values }),
    moveArtboard: async (slug, artboardId, position) => {
      await c(moveArtboard, { workspaceId, slug, artboardId, position });
    },
    sendToAgent: async (text) => {
      await c(sendToThread, { workspaceId, threadId: await thread(), text });
    },
    startDesign: async (brief) => {
      await c(askForDesign, { workspaceId, threadId: await thread(), brief });
    },
  };
}

