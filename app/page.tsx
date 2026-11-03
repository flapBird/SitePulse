import { DashboardView } from "@/components/dashboard-view";
import { requirePageSession } from "@/lib/guards";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requirePageSession("/");
  return <DashboardView />;
}
