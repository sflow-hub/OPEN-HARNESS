import subprocess
import unittest

import test_curl_http3 as original
from test_curl_http3 import curl_http3

@original.HAVE_CURL
class LoggingTests(unittest.TestCase):
 setUp=original.OfflineBuildFlow.setUp
 tearDown=original.OfflineBuildFlow.tearDown
 def invoke(self,code):
  fake=original.FakeBuild(self.debian_tar)
  def run(command,**kwargs):
   if command[0]=='dpkg-buildpackage':
    self.assertEqual(kwargs['capture_output'],True);self.assertEqual(kwargs['text'],True)
    if not code:fake(command,**kwargs)
    return subprocess.CompletedProcess(command,code,'distribution stdout marker\n','distribution stderr marker\n')
   return fake(command,**kwargs)
  return curl_http3.build(self.lock,self.work,self.out,run=run,builder=self.guard)
 def check_logs(self):
  p=self.out/'provenance'
  self.assertEqual((p/'dpkg-buildpackage.stdout.log').read_text(),'distribution stdout marker\n')
  self.assertEqual((p/'dpkg-buildpackage.stderr.log').read_text(),'distribution stderr marker\n')
 def test_complete_output_retained_on_success(self):
  self.invoke(0);self.check_logs();self.assertTrue((self.out/'debs').is_dir())
 def test_nonzero_build_preserves_output_and_propagates(self):
  with self.assertRaises(subprocess.CalledProcessError) as result:self.invoke(29)
  self.assertEqual(result.exception.returncode,29);self.check_logs();self.assertFalse((self.out/'debs').exists())
