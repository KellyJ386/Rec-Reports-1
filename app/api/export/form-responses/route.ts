import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseFormSchema, DISPLAY_ONLY } from "@/lib/facility/form-schema";
import { toCsv } from "@/lib/exports/csv";

/**
 * CSV export of a form's responses (MODULE_SPEC.md §3.3 / §6). RLS-scoped: a member only
 * exports responses they're allowed to read (author sees own; supervisor+ sees all).
 */
export async function GET(request: NextRequest) {
  const formId = request.nextUrl.searchParams.get("form_id");
  if (!formId) return new Response("form_id required", { status: 400 });

  const supabase = await createClient();
  const { data: form } = await supabase
    .from("form").select("name, schema_json").eq("id", formId).maybeSingle();
  if (!form) return new Response("Not found", { status: 404 });

  const { fields } = parseFormSchema(form.schema_json);
  const answerFields = fields.filter((f) => !DISPLAY_ONLY.includes(f.type));

  const { data: responses } = await supabase
    .from("form_response")
    .select("answers_json, submitted_at")
    .eq("form_id", formId)
    .is("deleted_at", null)
    .order("submitted_at", { ascending: false });

  const headers = ["submitted_at", ...answerFields.map((f) => f.label)];
  const rows = (responses ?? []).map((r) => {
    const answers = (r.answers_json ?? {}) as Record<string, unknown>;
    return [r.submitted_at, ...answerFields.map((f) => answers[f.key])];
  });

  const csv = toCsv(headers, rows);
  const filename = `${form.name.replace(/[^a-z0-9]+/gi, "_")}_responses.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
