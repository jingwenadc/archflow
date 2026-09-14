"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createProject, getProjects, type Project } from "@/lib/api";
import { CheckIcon, ChevronDown, PlusIcon } from "./icons";

const projectStorageKey = "archflow.active-project";

export function ProjectSwitcher() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState("cold-chain-industrial-park");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getProjects()
      .then((items) => {
        if (cancelled) return;
        setProjects(items);
        const savedId = window.localStorage.getItem(projectStorageKey);
        const next = items.find((project) => project.id === savedId) ?? items[0];
        if (next) setActiveId(next.id);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function dismiss(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const activeProject = projects.find((project) => project.id === activeId);

  function selectProject(project: Project) {
    setActiveId(project.id);
    window.localStorage.setItem(projectStorageKey, project.id);
    setOpen(false);
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject(name);
      setProjects((current) => [...current, project]);
      setName("");
      setCreating(false);
      selectProject(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="project-control" ref={rootRef}>
      <button
        className={open ? "project-switcher is-open" : "project-switcher"}
        type="button"
        aria-label={`切换项目，当前项目：${activeProject?.name ?? "冷链产业园"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <strong>{activeProject?.name ?? "冷链产业园"}</strong><ChevronDown />
      </button>

      {open && (
        <div className="project-menu">
          <div className="project-menu-heading"><strong>项目</strong><span>{projects.length}</span></div>
          <div className="project-menu-list" role="menu">
            {projects.map((project) => (
              <button key={project.id} type="button" role="menuitem" onClick={() => selectProject(project)}>
                <span>{project.name}</span>{project.id === activeId && <CheckIcon />}
              </button>
            ))}
          </div>

          {creating ? (
            <form className="new-project-form" onSubmit={(event) => void submitProject(event)}>
              <label htmlFor="new-project-name">项目名称</label>
              <input
                id="new-project-name"
                value={name}
                maxLength={80}
                autoFocus
                placeholder="例如：城市更新项目"
                onChange={(event) => setName(event.target.value)}
              />
              <div><button type="button" onClick={() => setCreating(false)}>取消</button><button type="submit" disabled={!name.trim() || submitting}>{submitting ? "创建中…" : "创建"}</button></div>
            </form>
          ) : (
            <button className="new-project-trigger" type="button" onClick={() => setCreating(true)}><PlusIcon />新建项目</button>
          )}
          {error && <p className="project-menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
