/**
 * Vocabulary re-exports for prompt construction.
 *
 * Exists so `session.ts` can build a prompt from the same lists the
 * validator enforces. If the prompt advertised terms the validator
 * rejects, every model answer would be silently discarded — the two
 * must read from one source.
 */
export { OCCASIONS, STYLES } from "./taxonomy";
export { WORKFLOWS } from "./intent";

import { WORKFLOWS } from "./intent";

export const WORKFLOWS_HINT = WORKFLOWS.join(" | ");
