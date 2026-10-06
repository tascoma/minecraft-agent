import pytest
import yaml

from app.core.config import get_settings

SKILLS = sorted(get_settings().skills_dir.glob('*/SKILL.md'))


@pytest.mark.parametrize('path', SKILLS, ids=lambda p: p.parent.name)
def test_skill_frontmatter_loads(path):
    """A skill with bad frontmatter (a stray colon, say) is skipped with only a warning, so check it here."""
    front = path.read_text().split('---')[1]
    meta = yaml.safe_load(front)
    assert meta['name'] == path.parent.name
    assert meta['description']
