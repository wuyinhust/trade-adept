import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.assets import REQUIRED, ensure


class SharedAssetTests(unittest.TestCase):
    def public(self, root):
        source = root / 'image' / 'public'
        for name in REQUIRED:
            file = source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(name)
        return source

    def test_shared_volume_reads_packaged_files_and_repeated_migration_keeps_link(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.public(root)
            volume = root / 'sites' / 'assets'
            ensure(volume, source)
            self.assertTrue((volume / 'tradept_core').is_symlink())
            for name in REQUIRED:
                self.assertEqual((volume / 'tradept_core' / name).read_bytes(), (source / name).read_bytes())
            ensure(volume, source)
            self.assertEqual((volume / 'tradept_core').resolve(), source.resolve())

    def test_incomplete_image_does_not_publish_a_partial_link(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.public(root)
            (source / REQUIRED[-1]).unlink()
            volume = root / 'sites' / 'assets'
            with self.assertRaises(RuntimeError):
                ensure(volume, source)
            self.assertFalse((volume / 'tradept_core').exists())

    def test_migration_refuses_to_overwrite_existing_files_or_another_asset_tree(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.public(root)
            volume = root / 'sites' / 'assets'
            volume.mkdir(parents=True)
            link = volume / 'tradept_core'
            link.write_text('preserve me')
            with self.assertRaises(RuntimeError):
                ensure(volume, source)
            self.assertEqual(link.read_text(), 'preserve me')
            link.unlink()
            other = root / 'old-public'
            other.mkdir()
            link.symlink_to(other, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                ensure(volume, source)
            self.assertEqual(link.resolve(), other.resolve())


if __name__ == '__main__':
    unittest.main()
