# 图策 ArchFlow

面向建筑设计团队的方案设计、投标文件与施工图协同工作台。

当前分支是可供团队评审的基础版本：前后端结构已经建立，项目资料与文字对话可持久保存。AI 回复、内容生成与技能调用仍保持禁用，工作流引擎仍为 TBD。

## 代码结构

```text
apps/web/       Next.js + React + TypeScript
services/api/   FastAPI 与本地文件存储适配器
skills/         已有建筑专业技能
dist/           旧版静态原型，暂时保留
PRODUCT_DESIGN.md
```

“案例 / 技能库”页面包含两个标签：技能以真实文件夹层级展示全部内容，并支持编辑后创建 GitHub Draft PR；案例提供独立文件上传入口。

现有技能：

- `architectural-concept-presentation`：建筑概念方案演示
- `aec-technical-bid-authoring`：建筑工程技术标编制

技术标技能保留了可独立运行的辅助脚本：

```bash
python skills/aec-technical-bid-authoring/scripts/extract_pdf_text.py input.pdf output.txt
python skills/aec-technical-bid-authoring/scripts/validate_bid_plan.py plan.json --stage final
```

## 本地评审

需要 Node.js 22、pnpm 11 和 Python 3.12+。

### Web

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。可评审方案设计、投标文件、施工图占位页、可折叠/拖动三栏、多聊天标签和案例 / 技能库。

### API

```bash
cd services/api
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
uvicorn archflow_api.main:app --reload
```

API 位于 `http://localhost:8000`，交互文档位于 `http://localhost:8000/docs`。

当前 API 提供：

- `GET /health`
- `GET /api/v1/capabilities`
- `GET /api/v1/projects`
- `POST /api/v1/projects`
- `GET /api/v1/conversations`
- `POST /api/v1/conversations`
- `GET /api/v1/conversations/{id}/messages`
- `POST /api/v1/conversations/{id}/messages`
- `GET /api/v1/skills`
- `GET /api/v1/skills/{slug}`
- `GET /api/v1/skills/{slug}/files/{path}`
- `POST /api/v1/skills/{slug}/draft-pr`
- `GET /api/v1/files`
- `POST /api/v1/files`
- `POST /api/v1/cases/files`

项目工作区默认位于 `.local/projects/{project_id}`，案例文件位于 `.local/cases`，普通项目上传位于 `.local/uploads`。这些都是评审阶段的本地适配器；正式环境会使用 PostgreSQL 与 S3 兼容对象存储。

## 当前边界

- 支持界面：图片、PDF、Word、Excel、PowerPoint 上传。
- 暂不支持：CAD/DWG、DXF、SketchUp、PKPM。
- 已启用：项目级文件列表、模块内多对话和用户文字消息的本地持久化。
- 暂不启用：AI 回复、内容生成、技能执行和认证。
- 工作流引擎候选：DBOS、Hatchet、Temporal；根据真实任务量和运维成本再决定。

完整产品、UX 和架构决定见 [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)。开发协作约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。
