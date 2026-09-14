export type ModuleKey = "concept" | "bid" | "drawing";

export type WorkspaceModule = {
  key: ModuleKey;
  label: string;
  href: string;
  eyebrow: string;
  conversations: string[];
  userExample: string;
  assistantExample: string;
  previewTitle: string;
  previewDescription: string;
  workflow: string[];
};

export const modules: WorkspaceModule[] = [
  {
    key: "concept",
    label: "方案设计",
    href: "/",
    eyebrow: "CONCEPT DESIGN",
    conversations: ["方案 PPT V1", "总平面修改", "立面效果优化"],
    userExample: "先读取任务书，帮我整理方案汇报的章节结构。",
    assistantExample:
      "收到。正式接入后，我会先提取项目条件并提交整体框架，待你确认后再展开逐页故事板。",
    previewTitle: "方案成果",
    previewDescription: "确认框架后，PPT 提纲、页面和导出版本会集中显示在这里。",
    workflow: ["上传任务书与基础资料", "确认项目条件与汇报框架", "生成并审阅方案成果"],
  },
  {
    key: "bid",
    label: "投标文件",
    href: "/bids",
    eyebrow: "BID DOCUMENT",
    conversations: ["投标响应矩阵", "技术标初稿", "缺口复核"],
    userExample: "先检查招标文件里的否决项和评分标准。",
    assistantExample:
      "正式接入后，我会先登记来源文件、提取硬性要求，再生成可逐项核对的响应矩阵。",
    previewTitle: "投标成果",
    previewDescription: "响应矩阵、章节审阅稿和导出文件会在这里按版本集中管理。",
    workflow: ["上传招标与企业资料", "确认脱敏范围与响应矩阵", "生成、复核并导出技术文件"],
  },
  {
    key: "drawing",
    label: "施工图协同",
    href: "/drawings",
    eyebrow: "DRAWING COORDINATION",
    conversations: ["专业协同规划"],
    userExample: "梳理建筑、结构、水、暖通、电气的协同边界。",
    assistantExample: "施工图能力仍在规划中。当前页面仅用于确认信息架构与协同方式。",
    previewTitle: "施工图成果",
    previewDescription: "后续将在这里查看专业图纸、校核结果和版本关系。",
    workflow: ["定义专业输入与责任边界", "建立图纸和规范数据模型", "接入 CAD 与专业计算工具"],
  },
];

export const skills = [
  {
    slug: "architectural-concept-presentation",
    name: "建筑概念方案演示",
    category: "方案设计",
    description: "将任务书、图纸、效果图和参考资料组织为可审阅、可编辑的建筑概念方案演示。",
    inputs: ["任务书", "基础图纸", "效果图与参考资料"],
    output: "PPTX / PDF / 逐页故事板",
    stages: ["整体框架审批", "逐页故事板审批", "按授权范围生成", "版本选择与整合"],
  },
  {
    slug: "aec-technical-bid-authoring",
    name: "建筑工程技术标编制",
    category: "投标文件",
    description: "从招标资料提取否决项、评分标准和证据缺口，形成可核验的技术响应。",
    inputs: ["招标文件", "评分办法", "企业资料与历史案例"],
    output: "响应矩阵 / DOCX / PDF",
    stages: ["来源登记", "否决项与评分提取", "证据映射", "编写与复核"],
  },
] as const;

export function getModule(key: ModuleKey) {
  const module = modules.find((item) => item.key === key);
  if (!module) throw new Error(`Unknown module: ${key}`);
  return module;
}
