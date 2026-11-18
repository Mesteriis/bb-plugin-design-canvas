import type { z } from "zod";

/** Describes one RPC: its wire name and the schemas of its input and output. */
export function defineRpc<I extends z.ZodType, O extends z.ZodType>(definition: { name: string; input: I; output: O }) {
  return definition;
}
export type Rpc<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = ReturnType<typeof defineRpc<I, O>>;
