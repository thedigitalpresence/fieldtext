/**
 * Public invoice / receipt page — the forwardable link behind "invoice bob".
 * The uuid in the URL is the unguessable token; there is no listing anywhere.
 * FieldText never texts the customer — the OPERATOR forwards this link.
 */
import { db } from "@/lib/supabase";
import { money } from "@/lib/templates";
import { Leaf } from "lucide-react";
import type { InvoiceRecord, InvoicePayload } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function InvoicePage({ params }: { params: { id: string } }) {
  // uuid sanity check before touching the DB.
  const ok = /^[0-9a-f-]{36}$/i.test(params.id);
  const { data } = ok
    ? await db().from("invoices").select("*").eq("id", params.id).maybeSingle()
    : { data: null };
  const inv = data as InvoiceRecord | null;

  if (!inv) {
    return (
      <main className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="text-lg font-semibold text-gray-700">This link isn&apos;t valid.</p>
        <p className="mt-1 text-sm text-gray-500">Ask for a fresh invoice link.</p>
      </main>
    );
  }

  const p = inv.payload as InvoicePayload;
  const es = p.lang === "es";
  const title = inv.kind === "receipt" ? (es ? "Recibo" : "Receipt") : (es ? "Factura" : "Invoice");
  const dateStr = new Date(p.date + "T00:00:00").toLocaleDateString(es ? "es-ES" : "en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <main className="mx-auto max-w-lg px-4 py-8 sm:py-12">
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-brand/5 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white"><Leaf className="h-5 w-5" /></span>
            <div>
              <p className="font-bold leading-tight text-gray-900">{p.business_name}</p>
              <p className="text-xs text-gray-500">{dateStr}</p>
            </div>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${inv.kind === "receipt" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
            {title}
          </span>
        </div>

        {/* Bill to */}
        <div className="px-5 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{es ? "Para" : "For"}</p>
          <p className="font-semibold text-gray-900">{p.client_name}</p>
          {p.client_address && <p className="text-sm text-gray-500">{p.client_address}</p>}
        </div>

        {/* Lines */}
        <div className="px-5 py-4">
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {p.lines.map((l, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800">{l.description}</p>
                  {l.due_on && (
                    <p className="text-xs text-gray-400">
                      {new Date(l.due_on + "T00:00:00").toLocaleDateString(es ? "es-ES" : "en-US", { month: "short", day: "numeric" })}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">{money(l.amount)}</span>
              </div>
            ))}
            <div className="flex items-baseline justify-between bg-gray-50 px-3.5 py-3">
              <span className="text-sm font-bold text-gray-900">{inv.kind === "receipt" ? (es ? "Pagado" : "Paid") : "Total"}</span>
              <span className="text-lg font-bold tabular-nums text-brand-dark">{money(p.total)}</span>
            </div>
          </div>
        </div>

        {/* How to pay */}
        {inv.kind === "invoice" && p.payment_note && (
          <div className="border-t border-gray-100 bg-green-50/50 px-5 py-3.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-green-800">{es ? "Cómo pagar" : "How to pay"}</p>
            <p className="mt-0.5 text-sm text-gray-700">{p.payment_note}</p>
          </div>
        )}
        {inv.kind === "receipt" && (
          <div className="border-t border-gray-100 bg-green-50/50 px-5 py-3.5 text-center text-sm font-medium text-green-800">
            {es ? "¡Gracias! ✅" : "Thank you! ✅"}
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-xs text-gray-400">
        {es ? "Generado con FieldText" : "Generated with FieldText"}
      </p>
    </main>
  );
}
