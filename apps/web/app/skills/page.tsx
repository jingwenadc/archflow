import { AppHeader } from "@/components/app-header";
import { LibraryWorkspace } from "@/components/library-workspace";

export default function SkillsPage() {
  return (
    <div className="app-shell skills-shell">
      <AppHeader active="skills" />
      <LibraryWorkspace />
    </div>
  );
}
