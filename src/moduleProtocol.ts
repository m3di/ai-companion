/**
 * The one constant both sides of the module boundary need.
 *
 * It lives alone because importing it must not run anything: `moduleHost.ts` is
 * an ENTRY POINT with a top-level body, so `import { SENTINEL } from
 * './moduleHost.js'` executed the host inside the parent — it read the parent's
 * stdin and called process.exit(0), which silently killed whatever was running.
 * A module that is a program does not also get to be a library.
 */
export const SENTINEL = ' __MODULE_RESULT__ ';
