import { WorkspaceShell } from "@/components/workspace-shell";
import { getModule } from "@/lib/workspace-data";

export default function BidPage() {
  return <WorkspaceShell module={getModule("bid")} />;
}
