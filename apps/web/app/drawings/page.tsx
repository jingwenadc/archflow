import { WorkspaceShell } from "@/components/workspace-shell";
import { getModule } from "@/lib/workspace-data";

export default function DrawingPage() {
  return <WorkspaceShell module={getModule("drawing")} />;
}
