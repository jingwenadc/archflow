# 图策 ArchFlow

面向建筑设计团队的方案设计、投标文件与施工图协同工作台。

当前版本有可选的 Pi 文档代理原型：提纲与逐页策划经用户确认后，分批生成、审校与修订内容草稿。默认禁用，需管理员配置模型 endpoint / 密钥。当前只用文字 brief，尚未解析上传资料或导出最终 PPTX/DOCX；聊天仍只保存文字。架构图、边界与配置统一见 [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)。

## 代码结构

```text
apps/web/       Next.js + React + TypeScript
services/api/   FastAPI 与本地文件存储适配器
services/agent/ Pi SDK Worker（Responses、受限工具、检查点恢复）
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

需要 Node.js 22.19+、pnpm 11 和 Python 3.12+。

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

### 可选 Pi Worker 与测试

使用 `.env.example` / `.env.production.example` 中的 `ARCHFLOW_AGENT_*`、`ARCHFLOW_WORKER_TOKEN` 和模型变量；生产 Compose 会自动启动一个独立 Worker。未配置时不调用模型。

```bash
pnpm --filter @archflow/agent build
# 本地：在终端设置同一组服务端环境变量后运行
pnpm --filter @archflow/agent start
# 需先按上文创建 services/api/.venv 并安装 API
pnpm --filter @archflow/agent test
services/api/.venv/bin/pytest services/api/tests -q
```

Pi 测试使用 localhost 模拟 Responses 供应商，不需要真实 API key；包括 100 单元的完整持久化任务。Python 模型变更后运行 `services/api/.venv/bin/python services/api/scripts/generate_job_contracts.py`，同步生成前端类型与工具 schema。更多配置、安全限制与架构图见主设计文档。

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

香港单机 Docker 部署、Basic Auth、HTTPS 和备份操作见 [DEPLOYMENT.md](DEPLOYMENT.md)。
