import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { LibraryIcon } from "@/components/icons";
import { skills } from "@/lib/workspace-data";

export default function SkillsPage() {
  return (
    <div className="app-shell skills-shell">
      <AppHeader active="skills" />

      <main className="skills-page">
        <header className="skills-intro">
          <p className="eyebrow">CASES &amp; SKILLS</p>
          <h1>案例 / 技能库</h1>
          <p>沉淀经过验证的专业方法，在方案设计或投标文件中按需调用。第一版先展示已有技能及其审批流程。</p>
        </header>

        <div className="skills-toolbar">
          <div className="filter-tabs" aria-label="技能分类">
            <button className="is-active" type="button">全部 <span>{skills.length}</span></button>
            <button type="button">方案设计</button>
            <button type="button">投标文件</button>
          </div>
          <button className="disabled-secondary" type="button" disabled>新建技能</button>
        </div>

        <section className="skill-grid" aria-label="现有技能">
          {skills.map((skill, skillIndex) => (
            <article className="skill-card" key={skill.slug}>
              <div className="skill-card-head">
                <span className={`skill-index skill-index-${skillIndex + 1}`}>{String(skillIndex + 1).padStart(2, "0")}</span>
                <span className="skill-category">{skill.category}</span>
                <span className="skill-state">已收录</span>
              </div>
              <h2>{skill.name}</h2>
              <p className="skill-description">{skill.description}</p>

              <dl className="skill-facts">
                <div><dt>输入</dt><dd>{skill.inputs.join("、")}</dd></div>
                <div><dt>输出</dt><dd>{skill.output}</dd></div>
              </dl>

              <div className="skill-process">
                <p>推荐流程</p>
                <ol>
                  {skill.stages.map((stage, index) => (
                    <li key={stage}><span>{index + 1}</span>{stage}</li>
                  ))}
                </ol>
              </div>

              <footer className="skill-card-footer">
                <code>skills/{skill.slug}</code>
                <Link className="skill-open-link" href={`/skills/${skill.slug}`}>查看并编辑</Link>
              </footer>
            </article>
          ))}
        </section>

        <aside className="skills-review-note">
          <LibraryIcon />
          <div><strong>当前仅用于界面与内容评审</strong><p>技能文件已保存在代码库中；与项目对话、文件解析和生成任务的连接将在工作流方案确定后开发。</p></div>
        </aside>
      </main>
    </div>
  );
}
