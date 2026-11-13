// src/errors.ts
export type Code = "E_NO_HOME" | "E_VERSION" | "E_HOME_IN_REPO" | "E_HOME_NOT_EMPTY" | "E_LOCKED" | "E_INPUT"
  | "E_NOT_FOUND" | "E_REFUSED" | "E_CARD";
export class MemoryError extends Error { constructor(readonly code: Code, message: string) { super(message); } }
