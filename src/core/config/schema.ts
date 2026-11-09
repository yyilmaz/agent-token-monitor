// A minimal, dependency-free schema description for the configuration file (ADR 0007).
// The TypeScript type of the configuration is inferred from the schema, so the two cannot drift.
// Bounds below are definitional limits of each value (e.g. a rate is within 0..1), not tunable thresholds.

export interface IntegerSchema {
  readonly kind: "integer";
  readonly min: number;
}

export interface NumberSchema {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  /** Most decimal places allowed, so the value converts exactly to an integer; null for no limit. */
  readonly maxDecimals: number | null;
}

export interface StringSchema {
  readonly kind: "string";
  /** When set, the value must match; `format` names the expected form in error messages. */
  readonly pattern: RegExp | null;
  readonly format: string | null;
}

export interface ArraySchema<I extends Schema = Schema> {
  readonly kind: "array";
  readonly items: I;
  readonly minItems: number;
  readonly strictlyAscending: boolean;
}

export interface ObjectSchema<F extends Readonly<Record<string, Schema | OptionalSchema>> = Readonly<Record<string, Schema | OptionalSchema>>> {
  readonly kind: "object";
  readonly fields: F;
}

/** An object field that may be left out; when present it must match `schema`. */
export interface OptionalSchema<S extends Schema = Schema> {
  readonly kind: "optional";
  readonly schema: S;
}

/**
 * An object with free-form keys (e.g. model IDs) and uniform values; `keys`, when set, lists the only keys allowed.
 */
export interface RecordSchema<V extends Schema = Schema> {
  readonly kind: "record";
  readonly values: V;
  readonly keys: readonly string[] | null;
}

export type Schema = IntegerSchema | NumberSchema | StringSchema | ArraySchema | ObjectSchema | RecordSchema;

export type Infer<S> = S extends IntegerSchema | NumberSchema
  ? number
  : S extends StringSchema
    ? string
    : S extends ArraySchema<infer I>
      ? readonly Infer<I>[]
      : S extends ObjectSchema<infer F>
        ? { readonly [K in keyof F as F[K] extends OptionalSchema ? never : K]: Infer<F[K]> } & {
            readonly [K in keyof F as F[K] extends OptionalSchema ? K : never]?: F[K] extends OptionalSchema<infer O> ? Infer<O> : never;
          }
        : S extends RecordSchema<infer V>
          ? Readonly<Record<string, Infer<V>>>
          : never;

export const integer = (min: number): IntegerSchema => ({ kind: "integer", min });

export const rate = (): NumberSchema => ({ kind: "number", min: 0, max: 1, maxDecimals: null });

const TOKEN_WEIGHT_DECIMALS = 6;
export const TOKEN_WEIGHT_SCALE = 10 ** TOKEN_WEIGHT_DECIMALS;

/** Token weights are represented exactly in millionths for ADVICE-1 (ADR 0017, R-51). */
export const tokenWeight = (): NumberSchema => ({
  kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER / TOKEN_WEIGHT_SCALE, maxDecimals: TOKEN_WEIGHT_DECIMALS,
});

export const string = (options: { readonly pattern?: RegExp; readonly format?: string } = {}): StringSchema => ({
  kind: "string",
  pattern: options.pattern ?? null,
  format: options.format ?? null,
});

export const array = <I extends Schema>(
  items: I,
  options: { readonly minItems?: number; readonly strictlyAscending?: boolean } = {},
): ArraySchema<I> => ({
  kind: "array",
  items,
  minItems: options.minItems ?? 0,
  strictlyAscending: options.strictlyAscending ?? false,
});

export const object = <F extends Readonly<Record<string, Schema | OptionalSchema>>>(fields: F): ObjectSchema<F> => ({
  kind: "object",
  fields,
});

export const optional = <S extends Schema>(schema: S): OptionalSchema<S> => ({ kind: "optional", schema });

export const record = <V extends Schema>(
  values: V,
  options: { readonly keys?: readonly string[] } = {},
): RecordSchema<V> => ({ kind: "record", values, keys: options.keys ?? null });

/** Harness IDs, the allowed keys of per-harness records (R-20). */
export const HARNESS_KEYS: readonly string[] = ["claudeCode", "antigravity", "codex", "opencode"];

/** The same object shape for every harness (R-20). */
export const perHarness = <S extends Schema>(value: S) =>
  object({ claudeCode: value, antigravity: value, codex: value, opencode: value });
