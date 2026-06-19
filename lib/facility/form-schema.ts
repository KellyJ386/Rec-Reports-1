import { z } from "zod";

/**
 * Dynamic form schema + server-side answer validation (MODULE_SPEC.md §3.3). The form
 * builder produces an ordered list of fields (stored in form.schema_json). Responses are
 * validated against the form's own schema on the server — client validation is UX only.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "yes_no",
  "single_select",
  "multi_select",
  "date",
  "time",
  "datetime",
  "rating",
  "section_header",
  "instructions",
  "signature",
  "file",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types that don't collect an answer (layout/help only). */
export const DISPLAY_ONLY: FieldType[] = ["section_header", "instructions"];

export const formFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  help: z.string().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formSchemaSchema = z.array(formFieldSchema);

/** Validate + normalize a form's field list (used when saving/publishing the builder). */
export function parseFormSchema(input: unknown): { fields: FormField[]; error?: string } {
  const result = formSchemaSchema.safeParse(input);
  if (!result.success) return { fields: [], error: result.error.issues[0]?.message ?? "Invalid form schema" };

  const keys = new Set<string>();
  for (const f of result.data) {
    if (keys.has(f.key)) return { fields: [], error: `Duplicate field key: ${f.key}` };
    keys.add(f.key);
    if ((f.type === "single_select" || f.type === "multi_select") && (!f.options || f.options.length === 0)) {
      return { fields: [], error: `Field "${f.label}" needs at least one option` };
    }
  }
  return { fields: result.data };
}

export type AnswerErrors = Record<string, string>;

/**
 * Validate a response's answers against the form schema. Returns field-keyed errors (empty
 * = valid) plus the cleaned value map. The source of truth (CLAUDE.md §9).
 */
export function validateAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
): { ok: boolean; errors: AnswerErrors; value: Record<string, unknown> } {
  const errors: AnswerErrors = {};
  const value: Record<string, unknown> = {};

  for (const field of fields) {
    if (DISPLAY_ONLY.includes(field.type)) continue;
    const raw = answers[field.key];
    const isEmpty =
      raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);

    if (isEmpty) {
      if (field.required) errors[field.key] = `${field.label} is required`;
      continue;
    }

    switch (field.type) {
      case "text":
      case "textarea":
      case "date":
      case "time":
      case "datetime":
      case "signature":
      case "file": {
        if (typeof raw !== "string") errors[field.key] = `${field.label} must be text`;
        else value[field.key] = raw;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (Number.isNaN(n)) errors[field.key] = `${field.label} must be a number`;
        else if (field.min != null && n < field.min) errors[field.key] = `${field.label} must be ≥ ${field.min}`;
        else if (field.max != null && n > field.max) errors[field.key] = `${field.label} must be ≤ ${field.max}`;
        else value[field.key] = n;
        break;
      }
      case "rating": {
        const n = typeof raw === "number" ? raw : Number(raw);
        const min = field.min ?? 1;
        const max = field.max ?? 5;
        if (Number.isNaN(n) || n < min || n > max) errors[field.key] = `${field.label} must be ${min}–${max}`;
        else value[field.key] = n;
        break;
      }
      case "yes_no": {
        if (typeof raw === "boolean") value[field.key] = raw;
        else if (raw === "true" || raw === "false") value[field.key] = raw === "true";
        else errors[field.key] = `${field.label} must be yes or no`;
        break;
      }
      case "single_select": {
        if (typeof raw !== "string" || !(field.options ?? []).includes(raw))
          errors[field.key] = `${field.label}: invalid choice`;
        else value[field.key] = raw;
        break;
      }
      case "multi_select": {
        const arr = Array.isArray(raw) ? raw : [raw];
        const opts = field.options ?? [];
        if (!arr.every((v) => typeof v === "string" && opts.includes(v)))
          errors[field.key] = `${field.label}: invalid choice`;
        else value[field.key] = arr;
        break;
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}
