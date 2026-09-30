"""One-time interactive administrator bootstrap; no password in env or shell history."""

import getpass

from .auth import AuthStore
from .config import load_settings
from .project_repository import ProjectRepository


def main() -> None:
    settings = load_settings()
    if not settings.signup_code:
        raise SystemExit("Set ARCHFLOW_SIGNUP_CODE before creating accounts.")
    store = AuthStore(settings.database_path, settings.signup_code, settings.secure_cookies)
    username = input("Admin username: ").strip()
    password = getpass.getpass("Admin password (12+ characters): ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match.")
    principal = store.create_user(username, password, "", role="admin")
    # Existing single-user projects become owned by the administrator, never
    # by the first ordinary account to sign up.
    projects = ProjectRepository(settings.project_dir)
    for project in projects.list():
        store.add_owner(project.id, principal.id)
    print(f"Created administrator {principal.username}; assigned existing projects.")


if __name__ == "__main__":
    main()
