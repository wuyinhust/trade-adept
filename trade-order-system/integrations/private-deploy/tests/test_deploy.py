import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'deploy.py'
spec=importlib.util.spec_from_file_location('private_deploy', MODULE)
d=importlib.util.module_from_spec(spec); spec.loader.exec_module(d)

class InstallerTests(unittest.TestCase):
    def test_host_and_tenant_cannot_inject_config(self):
        for host in ['https://example.com','example.com\nreverse_proxy evil','127.0.0.1','example.com:443','../x','x.test;']:
            with self.subTest(host=host), self.assertRaises(ValueError):d.validate(host,'enterprise','Company')
        for tenant in ['../sites','A B','enterprise\n','a'*32]:
            with self.subTest(tenant=tenant), self.assertRaises(ValueError):d.validate('trade.example.com',tenant,'Company')
        d.validate('trade.example.com','enterprise','公司')

    def test_only_loopback_backend_is_published(self):
        cfg={'image':'example:fixed','project':'tradept-test'}
        doc=d.compose_document('/opt/tradept-private',cfg)
        for name,s in doc['services'].items():
            if 'ports' in s:self.assertEqual((name,s['ports']),('frontend',['127.0.0.1:3088:8080']))
        self.assertEqual(doc['services']['https']['network_mode'],'host')
        self.assertEqual(doc['services']['init']['restart'],'no')
        self.assertNotIn('environment',doc['services']['backend'])
        self.assertTrue(all('@sha256:' in d.LOCK[k] for k in ['baseImage','databaseImage','redisImage','httpsImage']))

    def test_tampered_dependency_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/d.LOCK['wheels'][0]['name'];p.write_bytes(b'tampered')
            with patch.object(d.urllib.request,'urlopen') as network:
                with self.assertRaises(ValueError):d.materialize(directory)
                network.assert_not_called()
            p.unlink();p.symlink_to(Path(directory)/'elsewhere')
            with self.assertRaises(ValueError):d.materialize(directory)

    def test_private_file_cannot_overwrite_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'original';target.write_text('preserve')
            link=Path(directory)/'private';link.symlink_to(target)
            with self.assertRaises(ValueError):d.write(link,'changed')
            self.assertEqual(target.read_text(),'preserve')
            d.write(Path(directory)/'credential',{'secret':'value'})
            self.assertEqual((Path(directory)/'credential').stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
