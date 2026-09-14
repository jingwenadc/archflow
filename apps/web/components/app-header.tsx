import Link from "next/link";
import { modules, type ModuleKey } from "@/lib/workspace-data";
import { BrandMark } from "./brand";
import { ChevronDown, LibraryIcon } from "./icons";

export function AppHeader({ active }: { active: ModuleKey | "skills" }) {
  return (
    <header className="topbar">
      <Link className="brand-link" href="/" aria-label="返回方案设计"><BrandMark /></Link>
      <button className="project-switcher" type="button" aria-label="切换项目">
        <span className="project-label">示例项目</span><strong>冷链产业园</strong><ChevronDown />
      </button>
      <nav className="module-nav" aria-label="主要业务模块">
        {modules.map((item) => (
          <Link key={item.key} href={item.href} className={item.key === active ? "module-link is-active" : "module-link"}>
            {item.label}{item.key === "drawing" && <span>规划中</span>}
          </Link>
        ))}
      </nav>
      <div className="top-actions">
        <Link className={active === "skills" ? "library-link is-active" : "library-link"} href="/skills">
          <LibraryIcon />案例 / 技能库
        </Link>
        <span className="review-badge">界面评审版</span>
        <span className="avatar" aria-label="当前用户">J</span>
      </div>
    </header>
  );
}
