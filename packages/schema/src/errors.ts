export class BrnaValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly detail?: unknown;

  constructor(opts: { code: string; path: string; message: string; detail?: unknown }) {
    super(`${opts.message} (at ${opts.path})`);
    this.name = "BrnaValidationError";
    this.code = opts.code;
    this.path = opts.path;
    this.detail = opts.detail;
  }
}

export class BrnaSelectorParseError extends Error {
  readonly code: string;
  readonly column: number;

  constructor(opts: { code: string; column: number; message: string }) {
    super(`${opts.message} (column ${opts.column})`);
    this.name = "BrnaSelectorParseError";
    this.code = opts.code;
    this.column = opts.column;
  }
}
