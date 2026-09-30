from archflow_api.config import Settings, load_settings


def test_default_models_are_astra(monkeypatch, tmp_path):
    monkeypatch.delenv("ARCHFLOW_LLM_MODEL", raising=False)
    monkeypatch.delenv("ARCHFLOW_REVIEW_MODEL", raising=False)
    settings = load_settings()
    assert settings.llm_model == "gpt-6-astra"
    assert settings.review_model == "gpt-6-astra"
    assert Settings(upload_dir=tmp_path, allowed_origins=()).llm_model == "gpt-6-astra"


def test_models_can_still_be_overridden(monkeypatch):
    monkeypatch.setenv("ARCHFLOW_LLM_MODEL", "custom-generation")
    monkeypatch.setenv("ARCHFLOW_REVIEW_MODEL", "custom-review")
    settings = load_settings()
    assert settings.llm_model == "custom-generation"
    assert settings.review_model == "custom-review"
