import schema from "../dist/brna-1.schema.json" with { type: "json" };

export const JSON_SCHEMA = schema as Record<string, unknown>;
