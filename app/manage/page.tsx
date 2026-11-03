import { ManageView } from "@/components/manage-view";
import { requirePageSession } from "@/lib/guards";

export const dynamic = "force-dynamic";

export default async function ManagePage() {
  await requirePageSession("/manage");
  return <ManageView />;
}
