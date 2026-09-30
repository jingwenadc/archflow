"""验证纯文字内容校验与范围批准检查的关键行为，不生成幻灯片。"""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ChecksTest(unittest.TestCase):
    def run_check(self, script, data, *args):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.json"
            source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / script), str(source), *args],
                capture_output=True, text=True,
            )
        self.assertNotIn("Traceback", result.stderr)
        return result.returncode, result.stdout

    def storyboard(self):
        return json.loads((ROOT / "references/storyboard-example.json").read_text(encoding="utf-8"))

    def state(self):
        data = json.loads((ROOT / "references/project-state-example.json").read_text(encoding="utf-8"))
        # 仅用于测试，不代表真实用户批准。
        data["structure"]["approved"] = True
        data["storyboard"]["approved"] = True
        data["sections"][1]["authorized"] = True
        return data

    def test_product_proposals_can_plan_original_visuals_without_existing_assets(self):
        self.assertEqual(self.run_check("check_storyboard.py", self.storyboard())[0], 0)

    def test_storyboard_needs_actual_copy_and_visual_plan(self):
        for field in ("copy", "visual_plan"):
            data = self.storyboard()
            del data["slides"][0][field]
            with self.subTest(field=field):
                self.assertEqual(self.run_check("check_storyboard.py", data)[0], 1)

    def test_facts_and_charts_need_sources(self):
        for change in ({"fact_status": "fact"}, {"archetype": "data-chart"}):
            data = self.storyboard()
            data["slides"][0].update(change, evidence=[])
            with self.subTest(change=change):
                self.assertEqual(self.run_check("check_storyboard.py", data)[0], 1)

    def test_custom_layout_allowed_and_long_copy_warns(self):
        data = self.storyboard()
        data["slides"][0].update(archetype="custom", copy="说明" * 60)
        code, output = self.run_check("check_storyboard.py", data)
        self.assertEqual(code, 0)
        self.assertIn("正文超过", output)

    def test_malformed_storyboard_fails_cleanly(self):
        for value in ([], None):
            data = self.storyboard()
            data["slides"][0].update(archetype=value, evidence=value)
            with self.subTest(value=value):
                self.assertEqual(self.run_check("check_storyboard.py", data)[0], 1)

    def test_unapproved_template_cannot_generate(self):
        data = json.loads((ROOT / "references/project-state-example.json").read_text(encoding="utf-8"))
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "generate-section", "--section", "02")[0], 1)

    def test_either_missing_approval_prevents_generation(self):
        for block in ("structure", "storyboard"):
            data = self.state()
            data[block]["approved"] = False
            with self.subTest(block=block):
                self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "generate-section", "--section", "02")[0], 1)

    def test_section_two_does_not_wait_for_section_one(self):
        self.assertEqual(self.run_check("check_project_gate.py", self.state(), "--action", "generate-section", "--section", "02")[0], 0)

    def test_scope_and_revision_authorization(self):
        data = self.state()
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "generate-section", "--section", "01")[0], 1)
        data["sections"][1]["approved"] = True
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "generate-section", "--section", "02")[0], 1)
        data["sections"][1]["revisionAuthorized"] = True
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "generate-section", "--section", "02")[0], 0)

    def test_finalization_requires_selected_versions(self):
        data = self.state()
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "finalize")[0], 1)
        for section in data["sections"]:
            section.update(approved=True, selectedVersion="v01")
        self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "finalize")[0], 0)

    def test_malformed_state_and_duplicate_scope_fail_cleanly(self):
        malformed = self.state()
        malformed["sections"].append(None)
        duplicate = self.state()
        duplicate["sections"].append(copy.deepcopy(duplicate["sections"][0]))
        for data in ([], malformed, duplicate):
            with self.subTest(data=data):
                self.assertEqual(self.run_check("check_project_gate.py", data, "--action", "finalize")[0], 1)


if __name__ == "__main__":
    unittest.main()
