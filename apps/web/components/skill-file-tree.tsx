"use client";

import { useMemo, useState } from "react";
import type { SkillFile } from "@/lib/api";
import { ChevronDown, ChevronRight, EyeOffIcon, FileIcon, FolderIcon, ImageIcon } from "./icons";

type FolderNode = { type: "folder"; name: string; path: string; children: TreeNode[] };
type FileNode = { type: "file"; name: string; path: string; file: SkillFile };
type TreeNode = FolderNode | FileNode;

function buildTree(files: SkillFile[]): TreeNode[] {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    parts.slice(0, -1).forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let folder = parent.children.find(
        (node): node is FolderNode => node.type === "folder" && node.name === part,
      );
      if (!folder) {
        folder = { type: "folder", name: part, path, children: [] };
        parent.children.push(folder);
      }
      parent = folder;
    });
    parent.children.push({ type: "file", name: parts.at(-1) ?? file.path, path: file.path, file });
  }

  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      if (left.type === "file" && left.name === "SKILL.md") return -1;
      if (right.type === "file" && right.name === "SKILL.md") return 1;
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => { if (node.type === "folder") sortNodes(node.children); });
  }
  sortNodes(root.children);
  return root.children;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function FileKindIcon({ file }: { file: SkillFile }) {
  if (file.kind === "image") return <ImageIcon />;
  if (file.kind !== "markdown") return <EyeOffIcon />;
  return <FileIcon />;
}

export function SkillFileTree({
  files,
  selectedPath,
  changedPaths = [],
  onSelect,
}: {
  files: SkillFile[];
  selectedPath?: string;
  changedPaths?: string[];
  onSelect: (file: SkillFile) => void;
}) {
  const nodes = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const changed = new Set(changedPaths);

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function renderNodes(items: TreeNode[], depth = 0) {
    return items.map((node) => {
      if (node.type === "folder") {
        const isExpanded = expanded.has(node.path);
        return (
          <div className="skill-tree-branch" key={node.path}>
            <button className="skill-tree-folder" type="button" style={{ paddingLeft: 8 + depth * 16 }} onClick={() => toggle(node.path)}>
              {isExpanded ? <ChevronDown /> : <ChevronRight />}<FolderIcon /><strong>{node.name}</strong><small>{node.children.length}</small>
            </button>
            {isExpanded && renderNodes(node.children, depth + 1)}
          </div>
        );
      }

      const isTechnical = node.file.kind !== "markdown" && node.file.kind !== "image";
      return (
        <button
          className={`${node.path === selectedPath ? "skill-tree-file is-active" : "skill-tree-file"}${isTechnical ? " is-technical" : ""}`}
          key={node.path}
          type="button"
          style={{ paddingLeft: 28 + depth * 16 }}
          onClick={() => onSelect(node.file)}
          title={isTechnical ? "技术文件：不作为主要人工审阅内容" : node.path}
        >
          <FileKindIcon file={node.file} /><span>{node.name}</span>
          {changed.has(node.path) ? <i aria-label="已修改" /> : <em>{formatBytes(node.file.size)}</em>}
        </button>
      );
    });
  }

  return <nav className="skill-file-tree" aria-label="技能文件层级">{renderNodes(nodes)}</nav>;
}
