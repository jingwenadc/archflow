import { WorkspaceShell } from "@/components/workspace-shell";
import { getModule } from "@/lib/workspace-data";

export default function ConceptPage() {
  return <WorkspaceShell module={getModule("concept")} />;
}
