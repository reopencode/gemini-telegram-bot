"""`.env` loading does not override variables already in the environment."""
import os
import tempfile
import unittest
from pathlib import Path

import envfile


class EnvFileTest(unittest.TestCase):
    def test_load_dotenv_keeps_existing_and_strips_quotes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(
                "\n".join(
                    [
                        "FOO=fromfile",
                        'BAR="quoted"',
                        "# comment",
                        "export BAZ=1",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            os.environ["FOO"] = "already"
            os.environ.pop("BAR", None)
            os.environ.pop("BAZ", None)
            try:
                envfile.load_dotenv(path)
                self.assertEqual(os.environ["FOO"], "already")
                self.assertEqual(os.environ["BAR"], "quoted")
                self.assertEqual(os.environ["BAZ"], "1")
            finally:
                os.environ.pop("FOO", None)
                os.environ.pop("BAR", None)
                os.environ.pop("BAZ", None)


if __name__ == "__main__":
    unittest.main()
