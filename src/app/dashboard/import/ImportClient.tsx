"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, FileSpreadsheet, Camera, Trash2, Plus, Loader2 } from "lucide-react";

type Method = "text" | "csv" | "photo";
type Draft = {
  name: string; address?: string; amount?: number; billing_period?: string;
  service_description?: string; service_interval?: string; service_day?: string;
};
const PERIODS = ["", "monthly", "weekly", "biweekly", "one_time"];

export default function ImportClient({ labels: L }: { labels: Record<string, string> }) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function review() {
    setBusy(true); setError("");
    try {
      const fd = new FormData();
      fd.append("method", method);
      if (method === "text") fd.append("text", text);
      else if (file) fd.append("file", file);
      const res = await fetch("/api/import/parse", { method: "POST", body: fd });
      const json = await res.json();
      if (json.error === "photo_needs_key") { setError(L.photoNeedsKey); return; }
      if (json.error) { setError("Something went wrong reading that."); return; }
      setDrafts(json.drafts ?? []);
    } catch { setError("Something went wrong reading that."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!drafts) return;
    setBusy(true);
    try {
      const res = await fetch("/api/import/commit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drafts: drafts.filter((d) => d.name.trim()) }),
      });
      const json = await res.json();
      if (typeof json.count === "number") { router.push("/dashboard"); router.refresh(); }
    } finally { setBusy(false); }
  }

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds!.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const removeRow = (i: number) => setDrafts((ds) => ds!.filter((_, j) => j !== i));
  const addRow = () => setDrafts((ds) => [...(ds ?? []), { name: "" }]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <button onClick={() => router.push("/dashboard")} className="mb-3 text-sm text-gray-500 hover:text-gray-800">{L.backDash}</button>
      <h1 className="text-2xl font-bold tracking-tight">{L.importTitle}</h1>
      <p className="mt-1 text-sm text-gray-500">{L.importSubtitle}</p>

      {drafts === null ? (
        <>
          {/* Method tabs */}
          <div className="mt-5 grid grid-cols-3 gap-2">
            {([["text", ClipboardList, L.mPaste], ["csv", FileSpreadsheet, L.mCsv], ["photo", Camera, L.mPhoto]] as const).map(([m, Icon, lbl]) => (
              <button
                key={m}
                onClick={() => { setMethod(m as Method); setError(""); }}
                className={`flex min-h-[44px] flex-col items-center gap-1 rounded-xl border p-3 text-sm font-medium ${method === m ? "border-brand bg-brand/5 text-brand-dark" : "border-gray-200 bg-white text-gray-600"}`}
              >
                <Icon className="h-5 w-5" />{lbl}
              </button>
            ))}
          </div>

          {/* Input */}
          <div className="mt-4">
            {method === "text" ? (
              <textarea
                value={text} onChange={(e) => setText(e.target.value)} rows={8}
                placeholder={L.pastePlaceholder}
                className="w-full whitespace-pre-wrap rounded-xl border border-gray-300 p-3 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            ) : (
              <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600 hover:border-brand">
                {method === "csv" ? <FileSpreadsheet className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
                {file ? file.name : L.chooseFile}
                <input
                  type="file" className="hidden"
                  accept={method === "csv" ? ".csv,text/csv" : "image/*"}
                  capture={method === "photo" ? "environment" : undefined}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
          </div>

          {error && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>}

          <button
            onClick={review}
            disabled={busy || (method === "text" ? !text.trim() : !file)}
            className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 font-medium text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {L.reading}</> : L.reviewBtn}
          </button>
        </>
      ) : (
        /* Review & confirm */
        <div className="mt-5">
          {drafts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">{L.emptyDrafts}</div>
          ) : (
            <>
              <p className="mb-3 text-sm font-medium text-gray-700">{L.reviewTitle.replace("{n}", String(drafts.length))}</p>
              <div className="space-y-2">
                {drafts.map((d, i) => (
                  <div key={i} className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
                    <div className="flex items-center gap-2">
                      <input value={d.name} onChange={(e) => update(i, { name: e.target.value })} placeholder={L.colName}
                        className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm font-medium focus:border-brand focus:outline-none" />
                      <button onClick={() => removeRow(i)} title={L.remove} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <input value={d.address ?? ""} onChange={(e) => update(i, { address: e.target.value })} placeholder={L.colAddress}
                      className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-gray-600 focus:border-brand focus:outline-none" />
                    <div className="mt-2 flex gap-2">
                      <input inputMode="decimal" value={d.amount ?? ""} onChange={(e) => update(i, { amount: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder={L.colAmount}
                        className="w-24 rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-brand focus:outline-none" />
                      <select value={d.billing_period ?? ""} onChange={(e) => update(i, { billing_period: e.target.value || undefined })}
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-gray-600 focus:border-brand focus:outline-none">
                        {PERIODS.map((p) => <option key={p} value={p}>{p || L.colPeriod}</option>)}
                      </select>
                      <input value={d.service_description ?? ""} onChange={(e) => update(i, { service_description: e.target.value })} placeholder={L.colService}
                        className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-gray-600 focus:border-brand focus:outline-none" />
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={addRow} className="mt-2 text-sm font-medium text-brand-dark">{L.addRow}</button>
            </>
          )}

          <div className="mt-4 flex gap-2">
            <button onClick={() => { setDrafts(null); setFile(null); }} className="min-h-[44px] rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-100">{L.backDash}</button>
            {drafts.length > 0 && (
              <button onClick={save} disabled={busy} className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-4 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {L.saving}</> : L.saveClients.replace("{n}", String(drafts.filter((d) => d.name.trim()).length))}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
