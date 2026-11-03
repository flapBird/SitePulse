import { SiteDetailView } from "@/components/site-detail-view";

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SiteDetailView siteId={id} />;
}
