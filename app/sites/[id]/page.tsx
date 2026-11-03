import { SiteDetailView } from "@/components/site-detail-view";
import { requirePageSession } from "@/lib/guards";

export const dynamic = "force-dynamic";

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageSession(`/sites/${id}`);
  return <SiteDetailView siteId={id} />;
}
