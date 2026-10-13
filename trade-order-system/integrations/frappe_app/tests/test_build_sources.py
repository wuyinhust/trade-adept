import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location('tradept_unified_build', Path(__file__).resolve().parents[2] / 'erpnext/unified_build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildSourcesTests(unittest.TestCase):
    def write(self, root, paths):
        for name in paths:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)

    def test_native_modules_assets_licenses_and_website_files_are_all_selected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = ['pyproject.toml', 'tradept_core/modules.txt', 'tradept_core/finance.py',
                        'tradept_core/doctype/example/example.json', 'tradept_core/patches.txt',
                        'tradept_core/translations/zh.csv', 'tradept_core/public/js/desk-brand.js',
                        'tradept_core/public/licenses/ERPNext-GPL-3.0.txt',
                        'tradept_core/www/tradept-licenses.html', 'tradept_core/www/page/page.js']
            self.write(root, expected + ['tradept_core/tests/test_private.py', 'tradept_core/__pycache__/fake.py'])
            selected = [path.relative_to(root).as_posix() for path in builder.application_sources(root)]
            self.assertEqual(set(selected), set(expected))

    def test_symlink_and_private_configuration_cannot_enter_native_package(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, ['pyproject.toml', 'tradept_core/modules.txt', 'tradept_core/public/.env'])
            with self.assertRaises(ValueError):
                builder.application_sources(root)
            (root / 'tradept_core/public/.env').unlink()
            (root / 'tradept_core/linked.py').symlink_to(root / 'pyproject.toml')
            with self.assertRaises(ValueError):
                builder.application_sources(root)


if __name__ == '__main__':
    unittest.main()
