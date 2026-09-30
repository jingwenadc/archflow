import Link from "next/link";
import { modules, type ModuleKey } from "@/lib/workspace-data";
import { BrandMark } from "./brand";
import { LibraryIcon } from "./icons";
import { ProjectSwitcher } from "./project-switcher";
import { RunSettingsButton } from "./run-settings";
import { AccountMenu } from "./account-menu";

export function AppHeader({ active }: { active: ModuleKey | "skills" }) {
  return (
    <header className="topbar">
      <Link className="brand-link" href="/" aria-label="返回方案设计"><BrandMark /></Link>
      <nav className="module-nav" aria-label="主要业务模块">
        {modules.map((item) => (
          <Link key={item.key} href={item.href} className={item.key === active ? "module-link is-active" : "module-link"}>
            {item.label}{item.key === "drawing" && <span>规划中</span>}
          </Link>
        ))}
      </nav>
      <div className="top-actions">
        <ProjectSwitcher />
        <Link className={active === "skills" ? "library-link is-active" : "library-link"} href="/skills">
          <LibraryIcon />案例 / 技能库
        </Link>
        <RunSettingsButton />
        <AccountMenu />
      </div>
    </header>
  );
}
