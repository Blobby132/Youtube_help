from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        projects_dir=tmp_path / "projects",
        models_dir=tmp_path / "models",
        pexels_api_key=None,
        data_dir=tmp_path / "data",
        library_dir=tmp_path / "library",
        exports_dir=tmp_path / "exports",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as test_client:
        yield test_client
