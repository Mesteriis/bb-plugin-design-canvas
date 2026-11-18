// Design Canvas backend: the canvas's RPCs and the agent's design tools. The designs are files in
// the workspace's design/ folder, read and written by ./server/store (paseo's code).
import { existsSync } from "node:fs";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerHandlers, rpcContract } from "./server/handlers";
import { createDesignTools } from "./server/tools";
import { threadWorkspace } from "./server/workspace";

export { rpcContract };

/** The app opens a thread's Design tab when this arrives for the thread it is showing. */
export const OPEN_CHANNEL = "design-canvas:open";

const INSTRUCTIONS =
  "Design canvas: draw designs with design_create, then write each artboard as HTML under design/. Read design/README.md for the conventions. The user comments on the canvas and sends the comments as a message; revise the pages and call design_resolve_comments with a line on what you changed for each.";

export default async function plugin(bb: BbPluginApi) {
  registerHandlers(bb);
  const localHost = (await bb.sdk.system.config()).primaryHostId;
  const designTools = createDesignTools();

  for (const tool of designTools) {
    bb.agents.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.input,
      presentation: { label: { pending: tool.title, completed: tool.title } },
      async execute(input: unknown, { threadId }: { threadId: string }) {
        const { root } = await threadWorkspace(bb, threadId);
        const result = await tool.execute(input as never, { agent: { id: threadId, cwd: root } });
        // Drawing a design brings the canvas up beside the chat, as /canvas does in paseo.
        if (tool.name === "design_create" && !result.isError) bb.realtime.publish(OPEN_CHANNEL, { threadId });
        return result.isError ? { content: [{ type: "text" as const, text: result.text }], isError: true } : result.text;
      },
    });
  }

  // bb has no plugin slash commands, so a bare /canvas has the agent open the canvas with this.
  bb.agents.registerTool({
    name: "design_open",
    description: "Open the Design canvas beside this chat for the user.",
    parameters: z.object({}),
    presentation: { label: { pending: "Opening the design canvas", completed: "Opened the design canvas" } },
    async execute(_input: unknown, { threadId }: { threadId: string }) {
      bb.realtime.publish(OPEN_CHANNEL, { threadId });
      return "The Design canvas is open for the user.";
    },
  });

  const toolNames = [...designTools.map((tool) => tool.name), "design_open"];
  // The tools attach when a thread's session starts: threads the canvas started, and threads in a
  // workspace that already uses it. Elsewhere an agent works from design/README.md and the files.
  bb.agents.configure((context) => {
    const folder = context.environment.path;
    const enabled =
      context.host.id === localHost &&
      folder !== null &&
      (context.pluginMetadata.enabled === true || existsSync(path.join(folder, "design", "canvas.json")));
    return { tools: enabled ? toolNames : [], skills: ["canvas"], ...(enabled ? { instructions: INSTRUCTIONS } : {}) };
  });

  bb.onDispose(() => bb.log.info("disposed"));
}
