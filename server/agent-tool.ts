import type { z } from "zod";

export interface ToolResult {
  text: string;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  execute(input: never, context: { agent: { id: string; cwd: string } }): Promise<ToolResult>;
}

/** A design tool, independent of the host: the server registers it with bb. */
export function defineAgentTool<T extends z.ZodType>(definition: {
  name: string;
  title: string;
  description: string;
  input: T;
  execute(input: z.infer<T>, context: { agent: { id: string; cwd: string } }): Promise<ToolResult>;
}): AgentToolDefinition {
  return definition as unknown as AgentToolDefinition;
}
