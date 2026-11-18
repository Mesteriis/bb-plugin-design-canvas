import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import type { z } from "zod";
import type { Rpc } from "../shared/define";

/** Calls a canvas RPC by its definition, typed from the definition's schemas. */
export type Call = <R extends Rpc>(rpc: R, input: z.input<R["input"]>) => Promise<z.infer<R["output"]>>;

export function useCall(): Call {
  const rpc = useRpc() as unknown as { call(name: string, input: unknown): Promise<unknown> };
  return useCallback(((definition: Rpc, input: unknown) => rpc.call(definition.name, input)) as Call, [rpc]);
}
