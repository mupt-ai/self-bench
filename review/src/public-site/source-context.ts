import { createContext, useContext } from "react";
import type { PublicSource } from "./source";

export const SourceContext = createContext<PublicSource | undefined>(undefined);

export function useSource(): PublicSource {
  const source = useContext(SourceContext);
  if (!source) throw new Error("Public pages need a PublicSource");
  return source;
}
