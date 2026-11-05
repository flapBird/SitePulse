import { FunnelView } from "@/components/funnel-view";
import { requirePageSession } from "@/lib/guards";

export const dynamic = "force-dynamic";

export default async function SiteFunnelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageSession(`/sites/${id}/funnel`);
  return <FunnelView siteId={id} />;
}
