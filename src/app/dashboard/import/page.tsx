import { currentBusiness } from "@/lib/supabase";
import { businessLang } from "@/lib/templates";
import { dict } from "@/i18n";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import clients" };

export default async function ImportPage() {
  const business = await currentBusiness();
  const d = dict(businessLang(business));
  const labels = {
    importTitle: d.importTitle, importSubtitle: d.importSubtitle,
    mPaste: d.mPaste, mCsv: d.mCsv, mPhoto: d.mPhoto, pastePlaceholder: d.pastePlaceholder,
    reviewBtn: d.reviewBtn, chooseFile: d.chooseFile, photoNeedsKey: d.photoNeedsKey, reading: d.reading,
    reviewTitle: d.reviewTitle, emptyDrafts: d.emptyDrafts, saveClients: d.saveClients, saving: d.saving,
    savedClients: d.savedClients, addRow: d.addRow, remove: d.remove, backDash: d.backDash,
    colName: d.colName, colAddress: d.colAddress, colAmount: d.colAmount, colPeriod: d.colPeriod, colService: d.colService,
    genericError: d.genericError,
  };
  return <ImportClient labels={labels} />;
}
