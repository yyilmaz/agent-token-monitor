// Validates a parsed JSON value against a schema (ADR 0007).
// Unknown keys and null are errors, so a typo can never fall back to a default silently.

import type { OptionalSchema, Schema } from "./schema.js";

export interface ValidationError {
  /** Dotted path of the offending key; empty for the whole document. */
  readonly path: string;
  readonly message: string;
}

export interface ValidateOptions {
  /** When true, object fields may be missing (used for the user override file). */
  readonly partial: boolean;
}

export function validate(schema: Schema, value: unknown, options: ValidateOptions): ValidationError[] {
  const errors: ValidationError[] = [];
  check(schema, value, "", options, errors);
  return errors;
}

function check(schema: Schema, value: unknown, path: string, options: ValidateOptions, errors: ValidationError[]): void {
  if (value === null) {
    errors.push({ path, message: "null is not allowed" });
    return;
  }

  switch (schema.kind) {
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        errors.push({ path, message: `expected an integer, found ${describe(value)}` });
      } else if (value < schema.min) {
        errors.push({ path, message: `must be at least ${schema.min}, found ${value}` });
      }
      return;

    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({ path, message: `expected a number, found ${describe(value)}` });
      } else if (value < schema.min || value > schema.max) {
        errors.push({ path, message: `must be between ${schema.min} and ${schema.max}, found ${value}` });
      } else if (schema.maxDecimals !== null && !hasAtMostDecimals(value, schema.maxDecimals)) {
        errors.push({ path, message: `must have at most ${schema.maxDecimals} decimal places, found ${value}` });
      }
      return;

    case "string":
      if (typeof value !== "string") {
        errors.push({ path, message: `expected a string, found ${describe(value)}` });
      } else if (value.length === 0) {
        errors.push({ path, message: "must not be empty" });
      } else if (schema.pattern !== null && !schema.pattern.test(value)) {
        errors.push({ path, message: `expected ${schema.format ?? "a matching string"}, found ${JSON.stringify(value)}` });
      }
      return;

    case "date":
      if (typeof value !== "string" || !isCalendarDate(value)) {
        errors.push({ path, message: `expected a date as YYYY-MM-DD, found ${describe(value)}` });
      }
      return;

    case "array": {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `expected an array, found ${describe(value)}` });
        return;
      }
      if (value.length < schema.minItems) {
        errors.push({ path, message: `must have at least ${schema.minItems} item(s), found ${value.length}` });
      }
      value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, options, errors));
      if (schema.strictlyAscending) {
        for (let index = 1; index < value.length; index++) {
          const previous: unknown = value[index - 1];
          const current: unknown = value[index];
          if (typeof previous === "number" && typeof current === "number" && current <= previous) {
            errors.push({ path: `${path}[${index}]`, message: "values must be strictly ascending" });
          }
        }
      }
      return;
    }

    case "object": {
      if (!isPlainObject(value)) {
        errors.push({ path, message: `expected an object, found ${describe(value)}` });
        return;
      }
      for (const key of Object.keys(value).sort()) {
        if (!Object.hasOwn(schema.fields, key)) {
          errors.push({ path: join(path, key), message: "unknown key" });
        }
      }
      for (const key of Object.keys(schema.fields).sort()) {
        const field = schema.fields[key] as Schema | OptionalSchema;
        if (Object.hasOwn(value, key)) {
          check(field.kind === "optional" ? field.schema : field, value[key], join(path, key), options, errors);
        } else if (!options.partial && field.kind !== "optional") {
          errors.push({ path: join(path, key), message: "missing required key" });
        }
      }
      return;
    }

    case "record": {
      if (!isPlainObject(value)) {
        errors.push({ path, message: `expected an object, found ${describe(value)}` });
        return;
      }
      for (const key of Object.keys(value).sort()) {
        if (key.length === 0) errors.push({ path: join(path, key), message: "key must not be empty" });
        else if (schema.keys !== null && !schema.keys.includes(key)) {
          errors.push({ path: join(path, key), message: `unknown key; allowed: ${schema.keys.join(", ")}` });
          continue;
        } else if (schema.secondsKeys && !/^[1-9][0-9]*$/.test(key)) {
          errors.push({ path: join(path, key), message: "key must be a whole number of seconds, at least 1" });
          continue;
        }
        check(schema.values, value[key], join(path, key), options, errors);
      }
      return;
    }
  }
}

function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale === value;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}
