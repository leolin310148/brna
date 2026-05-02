export type BrnaRuntimeErrorCode =
  | "devtools_hook_missing"
  | "no_fiber_roots"
  | "no_react_native_renderer"
  | "capture_failed"
  | "bridge_send_failed";

export class BrnaRuntimeError extends Error {
  readonly code: BrnaRuntimeErrorCode;

  constructor(code: BrnaRuntimeErrorCode, message?: string) {
    super(message ?? defaultMessage(code));
    this.name = "BrnaRuntimeError";
    this.code = code;
  }
}

function defaultMessage(code: BrnaRuntimeErrorCode): string {
  switch (code) {
    case "devtools_hook_missing":
      return "__REACT_DEVTOOLS_GLOBAL_HOOK__ is not present — brna requires a dev build";
    case "no_fiber_roots":
      return "React DevTools hook is present but no fiber roots are registered";
    case "no_react_native_renderer":
      return "no React Native reconciler found among registered renderers";
    case "capture_failed":
      return "snapshot capture failed";
    case "bridge_send_failed":
      return "could not send a frame on the brna bridge";
  }
}
