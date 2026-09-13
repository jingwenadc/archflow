# 图策 ArchFlow

面向建筑设计团队的智能工作台，覆盖方案设计、投标文件与施工图协同。

## 当前内容

- dist：已发布的网站原型
- skills/architectural-concept-presentation：建筑概念方案演示技能
- skills/aec-technical-bid-authoring：建筑工程技术标编制技能
- PRODUCT_DESIGN.md：产品设计与交互说明

## 使用技能

- 使用 `$architectural-concept-presentation` 将任务书、图纸和效果图分阶段整理为建筑概念方案演示。
- 使用 `$aec-technical-bid-authoring` 从招标文件提取否决项、评分矩阵和证据缺口，再编制建筑设计或施工技术响应。

技术标技能包含两个可直接运行的辅助脚本：

```bash
python skills/aec-technical-bid-authoring/scripts/extract_pdf_text.py input.pdf output.txt
python skills/aec-technical-bid-authoring/scripts/validate_bid_plan.py plan.json --stage final
```

## 方案设计原则

方案演示采用人工审批工作流：

1. 先确认整体框架；
2. 再确认完整逐页故事板；
3. 获批后可在多个对话中并行处理不同章节；
4. 所有版本保存到共享方案工作区；
5. 用户明确选择版本后再整合终稿。

未经授权，不批量生成整套演示文稿。

## 开发协作

分支、提交和 Pull Request 约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。Codex 的仓库级工作规则见 [AGENTS.md](AGENTS.md)。
